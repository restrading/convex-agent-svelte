import {
  readable,
  writable,
  toStore,
  type Readable,
} from "svelte/store";
import { onDestroy } from "svelte";
import { useConvexClient, useQuery } from "convex-svelte";
import type { UsePaginatedQueryResult } from "convex/react";
import type {
  FunctionArgs,
  FunctionReference,
  PaginationOptions,
  PaginationResult,
} from "convex/server";
import {
  combineUIMessages,
  type UIMessage,
  type UIStatus,
} from "../UIMessages.js";
import { sorted } from "../shared.js";
import type { SyncStreamsReturnValue } from "../client/types.js";
import type { StreamArgs } from "../validators.js";
import type { StreamQuery } from "./types.js";
import { useStreamingUIMessages } from "./useStreamingUIMessages.svelte.js";
import {
  subscribeToValue,
  getCurrentValue,
  toReactiveGetter,
  type MaybeReadable,
} from "./storeUtils.js";

type UIMessageLike = {
  order: number;
  stepOrder: number;
  status: UIStatus;
  parts: UIMessage["parts"];
  role: UIMessage["role"];
};

export type UIMessagesQuery<
  Args = unknown,
  M extends UIMessageLike = UIMessageLike,
> = FunctionReference<
  "query",
  "public",
  {
    threadId: string;
    paginationOpts: PaginationOptions;
    streamArgs?: StreamArgs;
  } & Args,
  PaginationResult<M> & { streams?: SyncStreamsReturnValue }
>;

export type UIMessagesQueryArgs<
  Query extends UIMessagesQuery<unknown, UIMessageLike>,
> = Query extends UIMessagesQuery<unknown, UIMessageLike>
  ? FunctionArgs<Query> extends infer F
    ? F extends { paginationOpts: PaginationOptions }
      ? Omit<F, "paginationOpts" | "streamArgs">
      : never
    : never
  : never;

export type UIMessagesQueryResult<
  Query extends UIMessagesQuery<unknown, UIMessageLike>,
> = Query extends UIMessagesQuery<unknown, infer M> ? M : never;

type PaginationStatus = UsePaginatedQueryResult<UIMessage>["status"];

type PaginatedStoreValue<M> = UsePaginatedQueryResult<M>;

export function useUIMessages<Query extends UIMessagesQuery<any, any>>(
  query: Query,
  argsInput: MaybeReadable<UIMessagesQueryArgs<Query> | "skip">,
  options: {
    initialNumItems: number;
    stream?: Query extends StreamQuery
      ? boolean
      : never;
    skipStreamIds?: string[];
  },
): Readable<PaginatedStoreValue<UIMessagesQueryResult<Query>>> & {
  loadMore: (numItems?: number) => Promise<void>;
} {
  const client = useConvexClient();
  const paginatedStore = createPaginatedStore(
    client,
    query,
    argsInput,
    options.initialNumItems,
  );

  const streamingArgs = options.stream
    ? createStreamingArgsReadable(argsInput, paginatedStore)
    : ("skip" as const);

  const startOrderReadable = options.stream
    ? readable<number>(0, (set) =>
        paginatedStore.subscribe((value) => {
          if (!value.results.length) {
            set(0);
            return;
          }
          set(Math.min(...value.results.map((message) => message.order)));
        }),
      )
    : undefined;

  const streamingStore =
    options.stream && (query as unknown as StreamQuery<any>)
      ? useStreamingUIMessages(
          query as unknown as StreamQuery<any>,
          streamingArgs,
          {
            startOrder: startOrderReadable,
            skipStreamIds: options.skipStreamIds,
          },
        )
      : readable<UIMessage[] | undefined>(undefined, () => () => {});

  const combined = readable<PaginatedStoreValue<UIMessagesQueryResult<Query>>>(
    {
      results: [],
      status: "LoadingFirstPage",
      isLoading: true,
      loadMore: paginatedStore.loadMore,
    } as PaginatedStoreValue<UIMessagesQueryResult<Query>>,
    (set) => {
      let paginatedValue: PaginatedStoreValue<UIMessagesQueryResult<Query>> = {
        results: [],
        status: "LoadingFirstPage",
        isLoading: true,
        loadMore: paginatedStore.loadMore,
      } as PaginatedStoreValue<UIMessagesQueryResult<Query>>;
      let streamingValue: UIMessagesQueryResult<Query>[] | undefined;

      function emit() {
        const merged = mergeMessages(
          paginatedValue.results,
          streamingValue ?? [],
        );
        set({
          ...paginatedValue,
          results: merged,
        });
      }

      const unsubscribePaginated = paginatedStore.subscribe((value) => {
        paginatedValue = value;
        emit();
      });
      const unsubscribeStreaming = streamingStore.subscribe((value) => {
        streamingValue = value as UIMessagesQueryResult<Query>[] | undefined;
        emit();
      });

      return () => {
        unsubscribePaginated();
        unsubscribeStreaming();
      };
    },
  );

  return {
    subscribe: combined.subscribe,
    loadMore: paginatedStore.loadMore,
  };
}

function createPaginatedStore<Query extends UIMessagesQuery<any, any>>(
  client: ReturnType<typeof useConvexClient>,
  query: Query,
  argsInput: MaybeReadable<UIMessagesQueryArgs<Query> | "skip">,
  initialNumItems: number,
): Readable<PaginatedStoreValue<UIMessagesQueryResult<Query>>> & {
  loadMore: (numItems?: number) => Promise<void>;
} {
  const getArgs = toReactiveGetter(argsInput);
  const argsStore = toStore(() => getArgs());
  const liveQuery = useQuery(query, () => buildInitialArgs(getArgs()));
  const liveStore = toStore(() => liveQuery.data);

  let currentArgs: UIMessagesQueryArgs<Query> | "skip" = getArgs();
  let historical: UIMessagesQueryResult<Query>[] = [];
  let latest: UIMessagesQueryResult<Query>[] = [];
  let nextCursor: string | null = null;
  let loadingInitial = currentArgs !== "skip";
  let loadingOlder = false;

  const loadMore = async (numItems = initialNumItems) => {
    if (
      !nextCursor ||
      loadingOlder ||
      currentArgs === "skip" ||
      numItems <= 0
    ) {
      return;
    }
    loadingOlder = true;
    updateStatus();
    try {
      const result = await client.query(query, {
        ...(currentArgs as Record<string, unknown>),
        paginationOpts: {
          cursor: nextCursor,
          numItems,
        },
      } as FunctionArgs<Query>);
      const page = (result.page ?? []) as UIMessagesQueryResult<Query>[];
      historical = dedupeMessages(historical.concat(page), []);
      nextCursor = result.isDone ? null : result.continueCursor ?? null;
    } finally {
      loadingOlder = false;
      updateStatus();
    }
  };

  const store = writable<PaginatedStoreValue<UIMessagesQueryResult<Query>>>(
    {
      results: [],
      status: "LoadingFirstPage",
      isLoading: true,
      loadMore,
    } as PaginatedStoreValue<UIMessagesQueryResult<Query>>,
  );

  const unsubscribeArgs = argsStore.subscribe((argsValue) => {
    currentArgs = argsValue;
    historical = [];
    latest = [];
    nextCursor = null;
    loadingInitial = argsValue !== "skip";
    updateStatus();
    if (argsValue === "skip") {
      return;
    }
    fetchInitial(argsValue);
  });

  const unsubscribeLive = liveStore.subscribe((result) => {
    if (currentArgs === "skip") {
      latest = [];
      nextCursor = null;
      loadingInitial = false;
      updateStatus();
      return;
    }
    if (!result) {
      return;
    }
    latest = (result.page ?? []) as UIMessagesQueryResult<Query>[];
    nextCursor = result.isDone ? null : result.continueCursor ?? null;
    loadingInitial = false;
    updateStatus();
  });

  onDestroy(() => {
    unsubscribeArgs();
    unsubscribeLive();
  });

  return {
    subscribe: store.subscribe,
    loadMore,
  };

  function updateStatus() {
    const merged = combineUIMessages(
      sorted(dedupeMessages([...historical, ...latest], [])),
    ) as UIMessagesQueryResult<Query>[];
    const status = computeStatus();
    store.set({
      results: merged,
      status,
      isLoading: status === "LoadingFirstPage" || status === "LoadingMore",
      loadMore,
    } as PaginatedStoreValue<UIMessagesQueryResult<Query>>);
  }

  function computeStatus(): PaginationStatus {
    if (currentArgs === "skip") {
      return "LoadingFirstPage";
    }
    if (loadingInitial) {
      return "LoadingFirstPage";
    }
    if (loadingOlder) {
      return "LoadingMore";
    }
    return nextCursor ? "CanLoadMore" : "Exhausted";
  }

  async function fetchInitial(argsValue: UIMessagesQueryArgs<Query>) {
    loadingInitial = true;
    updateStatus();
    try {
      const initial = await client.query(query, {
        ...argsValue,
        paginationOpts: {
          cursor: null,
          numItems: initialNumItems,
        },
      } as FunctionArgs<Query>);
      latest = (initial.page ?? []) as UIMessagesQueryResult<Query>[];
      nextCursor = initial.isDone
        ? null
        : initial.continueCursor ?? null;
    } finally {
      loadingInitial = false;
      updateStatus();
    }
  }

  function buildInitialArgs(
    args: UIMessagesQueryArgs<Query> | "skip",
  ): FunctionArgs<Query> | "skip" {
    if (args === "skip") {
      return "skip";
    }
    return {
      ...args,
      paginationOpts: {
        cursor: null,
        numItems: initialNumItems,
      },
    } as FunctionArgs<Query>;
  }
}

function createStreamingArgsReadable<Query extends UIMessagesQuery<any, any>>(
  argsInput: MaybeReadable<UIMessagesQueryArgs<Query> | "skip">,
  paginatedStore: Readable<PaginatedStoreValue<UIMessagesQueryResult<Query>>>,
) {
  return readable<
    (UIMessagesQueryArgs<Query> & {
      paginationOpts: { cursor: null; numItems: 0 };
    })
      | "skip"
  >("skip", (set) => {
    let latestArgs = getCurrentValue(argsInput);
    let latestStatus: PaginationStatus = "LoadingFirstPage";

    function emit() {
      if (latestArgs === "skip" || latestStatus === "LoadingFirstPage") {
        set("skip");
      } else {
        set({
          ...(latestArgs as Record<string, unknown>),
          paginationOpts: {
            cursor: null,
            numItems: 0,
          },
        } as UIMessagesQueryArgs<Query> & {
          paginationOpts: { cursor: null; numItems: 0 };
        });
      }
    }

    const unsubscribeArgs = subscribeToValue(argsInput, (value) => {
      latestArgs = value;
      emit();
    });
    const unsubscribePaginated = paginatedStore.subscribe((value) => {
      latestStatus = value.status;
      emit();
    });

    return () => {
      unsubscribeArgs();
      unsubscribePaginated();
    };
  });
}

function mergeMessages<M extends { order: number; stepOrder: number; status: UIStatus }>(
  paginated: M[],
  streaming: M[],
): M[] {
  if (!streaming.length) {
    return paginated;
  }
  return dedupeMessages(paginated, streaming);
}

export function dedupeMessages<
  M extends { order: number; stepOrder: number; status: UIStatus },
>(messages: M[], streamMessages: M[]): M[] {
  return sorted(messages.concat(streamMessages)).reduce((msgs, msg) => {
    const last = msgs.at(-1);
    if (!last) return [msg];
    if (last.order !== msg.order || last.stepOrder !== msg.stepOrder) {
      return [...msgs, msg];
    }
    if (
      (last.status === "pending" || last.status === "streaming") &&
      msg.status !== "pending"
    ) {
      return [...msgs.slice(0, -1), msg];
    }
    return msgs;
  }, [] as M[]);
}
