import {
  readable,
  writable,
  toStore,
  fromStore,
  type Readable,
} from "svelte/store";
import { useQuery } from "convex-svelte";
import { assert } from "convex-helpers";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { sorted } from "../shared.js";
import type { StreamDelta, StreamMessage, StreamArgs } from "../validators.js";
import type { StreamQuery, StreamQueryArgs } from "./types.js";
import {
  toReactiveGetter,
  type MaybeReadable,
} from "./storeUtils.js";
import type { SyncStreamsReturnValue } from "../client/types.js";

type DeltaStream = {
  streamMessage: StreamMessage;
  deltas: StreamDelta[];
};

type DeltaStreamState = {
  threadId?: string;
  startOrder: number;
  deltaStreams: DeltaStream[] | undefined;
};

export function useDeltaStreams<Query extends StreamQuery<any>>(
  query: Query,
  argsInput: MaybeReadable<StreamQueryArgs<Query> | "skip">,
  options?: {
    startOrder?: MaybeReadable<number | undefined>;
    skipStreamIds?: string[];
  },
): Readable<DeltaStream[] | undefined> {
  const getArgs = toReactiveGetter(argsInput);
  const argsStore = toStore(() => getArgs());
  const getStartOrder = options?.startOrder
    ? toReactiveGetter(options.startOrder)
    : undefined;
  const skipStreamIds = options?.skipStreamIds ?? [];

  const streamMessagesStore = writable<StreamMessage[] | undefined>(undefined);
  const streamMessagesSignal = fromStore(streamMessagesStore);

  const initialArgs = getArgs();
  const state: DeltaStreamState = {
    threadId: initialArgs === "skip" ? undefined : initialArgs.threadId,
    startOrder: normalizeStart(getStartOrder?.() ?? 0),
    deltaStreams: undefined,
  };
  let cursors: Record<string, number> = {};

  const listQuery = useQuery(
    query,
    () => buildListArgs(getArgs(), cacheFriendlyStartOrder()),
  );

  const deltaQuery = useQuery(query, () => {
    const args = getArgs();
    if (args === "skip") {
      return "skip";
    }
    const streamMessages = streamMessagesSignal.current;
    if (!streamMessages?.length) {
      return "skip";
    }
    return {
      ...args,
      streamArgs: {
        kind: "deltas",
        cursors: streamMessages.map(({ streamId }) => ({
          streamId,
          cursor: cursors[streamId] ?? 0,
        })),
      } satisfies StreamArgs,
    } as FunctionArgs<Query>;
  });

  const listStore = toStore(() => listQuery.data);
  const deltasStore = toStore(() => deltaQuery.data);

  return readable<DeltaStream[] | undefined>(undefined, (set) => {
    const unsubscribeArgs = argsStore.subscribe((args) => {
      if (args === "skip") {
        resetState(set);
        return;
      }
      if (state.threadId && state.threadId !== args.threadId) {
        resetState(set, args.threadId);
        return;
      }
      state.threadId = args.threadId;
    });

    const unsubscribeList = listStore.subscribe((result) => {
      const args = getArgs();
      if (args === "skip") {
        resetState(set);
        return;
      }
      const streamMessages = extractStreamMessages(result);
      if (!streamMessages) {
        return;
      }
      streamMessagesStore.set(streamMessages);
      state.deltaStreams = streamMessages.map((streamMessage) => {
        const existing = state.deltaStreams?.find(
          ({ streamMessage: prev }) => prev.streamId === streamMessage.streamId,
        );
        if (!cursors[streamMessage.streamId]) {
          cursors[streamMessage.streamId] = 0;
        }
        return {
          streamMessage,
          deltas: existing?.deltas ?? [],
        };
      });
      set(state.deltaStreams);
    });

    const unsubscribeDeltas = deltasStore.subscribe((result) => {
      if (!result || result.streams?.kind !== "deltas") {
        return;
      }
      if (!result.streams.deltas.length || !state.deltaStreams?.length) {
        return;
      }
      const newDeltasByStream = new Map<string, StreamDelta[]>();
      for (const delta of result.streams.deltas) {
        const previousCursor = cursors[delta.streamId];
        if (previousCursor && delta.start < previousCursor) {
          continue;
        }
        const existing = newDeltasByStream.get(delta.streamId);
        if (existing) {
          const previousEnd = existing.at(-1)!.end;
          assert(
            previousEnd === delta.start,
            `Gap found in deltas for ${delta.streamId} jumping to ${delta.start} from ${previousEnd}`,
          );
          existing.push(delta);
        } else {
          if (previousCursor) {
            assert(
              previousCursor === delta.start,
              `Gap found - first delta after ${previousCursor} is ${delta.start} for stream ${delta.streamId}`,
            );
          }
          newDeltasByStream.set(delta.streamId, [delta]);
        }
      }
      if (!newDeltasByStream.size) {
        return;
      }
      state.deltaStreams = state.deltaStreams.map((entry) => {
        const appended = newDeltasByStream.get(entry.streamMessage.streamId);
        if (!appended) {
          return entry;
        }
        const merged = [...entry.deltas, ...appended];
        cursors[entry.streamMessage.streamId] = merged.at(-1)!.end;
        return {
          streamMessage: entry.streamMessage,
          deltas: merged,
        };
      });
      set(state.deltaStreams);
    });

    return () => {
      unsubscribeArgs();
      unsubscribeList();
      unsubscribeDeltas();
    };
  });

  function resetState(set: (value: DeltaStream[] | undefined) => void, threadId?: string) {
    state.threadId = threadId;
    state.deltaStreams = undefined;
    state.startOrder = normalizeStart(getStartOrder?.() ?? 0);
    streamMessagesStore.set(undefined);
    cursors = {};
    set(undefined);
  }

  function cacheFriendlyStartOrder() {
    const optionStart = getStartOrder?.();
    if (
      state.deltaStreams?.length ||
      (optionStart !== undefined && optionStart < state.startOrder)
    ) {
      const next = optionStart !== undefined ? optionStart : 0;
      const rounded = normalizeStart(next);
      if (rounded !== state.startOrder) {
        state.startOrder = rounded;
      }
    }
    return state.startOrder < 0 ? 0 : state.startOrder;
  }

  function normalizeStart(value: number) {
    if (!Number.isFinite(value) || value < 0) {
      return 0;
    }
    const rounded = value - (value % 10);
    return rounded < 0 ? 0 : rounded;
  }

  function buildListArgs(
    args: StreamQueryArgs<Query> | "skip",
    startOrder: number,
  ): FunctionArgs<Query> | "skip" {
    if (args === "skip") {
      return "skip";
    }
    return {
      ...args,
      streamArgs: {
        kind: "list",
        startOrder,
      } satisfies StreamArgs,
    } as FunctionArgs<Query>;
  }

  function extractStreamMessages(
    result: FunctionReturnType<Query> | undefined,
  ): StreamMessage[] | undefined {
    const streams = hasStreams(result) ? result.streams : undefined;
    if (!streams || streams.kind !== "list") {
      return undefined;
    }
    const filtered = sorted(
      streams.messages.filter(
        ({ streamId, order }) =>
          !skipStreamIds.includes(streamId) &&
          (!getStartOrder?.() || order >= (getStartOrder?.() ?? 0)),
      ),
    );
    return filtered;
  }
}

function hasStreams(
  value: unknown,
): value is { streams?: SyncStreamsReturnValue } {
  return typeof value === "object" && value !== null && "streams" in value;
}
