import { readable, type Readable } from "svelte/store";
import type { UIDataTypes, UIMessageChunk, UITools } from "ai";
import type { StreamQuery, StreamQueryArgs } from "./types.js";
import type { UIMessage } from "../UIMessages.js";
import {
  blankUIMessage,
  deriveUIMessagesFromTextStreamParts,
  getParts,
  updateFromUIMessageChunks,
} from "../deltas.js";
import { useDeltaStreams } from "./useDeltaStreams.svelte.js";
import {
  getCurrentValue,
  subscribeToValue,
  type MaybeReadable,
} from "./storeUtils.js";

type MessageState<
  METADATA,
  DATA_PARTS extends UIDataTypes,
  TOOLS extends UITools,
> = Record<
  string,
  {
    uiMessage: UIMessage<METADATA, DATA_PARTS, TOOLS>;
    cursor: number;
  }
>;

export function useStreamingUIMessages<
  METADATA = unknown,
  DATA_PARTS extends UIDataTypes = UIDataTypes,
  TOOLS extends UITools = UITools,
  Query extends StreamQuery<any> = StreamQuery<object>,
>(
  query: Query,
  argsInput: MaybeReadable<StreamQueryArgs<Query> | "skip">,
  options?: {
    startOrder?: MaybeReadable<number | undefined>;
    skipStreamIds?: string[];
  },
): Readable<UIMessage<METADATA, DATA_PARTS, TOOLS>[] | undefined> {
  const streamStore = useDeltaStreams(query, argsInput, options);
  let argsSnapshot = getCurrentValue(argsInput);

  return readable<
    UIMessage<METADATA, DATA_PARTS, TOOLS>[] | undefined
  >(undefined, (set) => {
    let state: MessageState<METADATA, DATA_PARTS, TOOLS> = {};
    let abortController: AbortController | null = null;
    const unsubscribeArgs = subscribeToValue(argsInput, (value) => {
      argsSnapshot = value;
    });

    const unsubscribe = streamStore.subscribe((streams) => {
      if (!streams || !streams.length) {
        state = {};
        set(streams ? [] : undefined);
        return;
      }
      abortController?.abort();
      const controller = new AbortController();
      abortController = controller;
      void (async () => {
        const entries = await Promise.all(
          streams.map(async ({ deltas, streamMessage }) => {
            const { parts, cursor } = getParts<UIMessageChunk>(deltas, 0);
            if (streamMessage.format === "UIMessageChunk") {
              const uiMessage = await updateFromUIMessageChunks(
                blankUIMessage(
                  streamMessage,
                  argsSnapshot === "skip" ? undefined : argsSnapshot.threadId,
                ),
                parts,
              );
              return { streamId: streamMessage.streamId, uiMessage, cursor };
            }
            const [uiMessages] = deriveUIMessagesFromTextStreamParts(
              argsSnapshot === "skip" ? undefined : argsSnapshot.threadId,
              [streamMessage],
              [],
              deltas,
            );
            return {
              streamId: streamMessage.streamId,
              uiMessage: uiMessages[0],
              cursor,
            };
          }),
        );
        if (controller.signal.aborted) {
          return;
        }
        const nextState: MessageState<METADATA, DATA_PARTS, TOOLS> = {};
        for (const entry of entries) {
          if (!entry.uiMessage) continue;
          const typedMessage =
            entry.uiMessage as UIMessage<METADATA, DATA_PARTS, TOOLS>;
          nextState[entry.streamId] = {
            uiMessage: typedMessage,
            cursor: entry.cursor,
          };
        }
        state = nextState;
        set(Object.values(state).map(({ uiMessage }) => uiMessage));
      })();
    });

    return () => {
      abortController?.abort();
      unsubscribe();
      unsubscribeArgs();
    };
  });
}
