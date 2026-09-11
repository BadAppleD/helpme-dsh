function textFromAssistantMessage(event) {
  if (event?.type !== "assistant/message") return undefined;
  const content = event.data?.message?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  return text.trim().length === 0 ? undefined : text;
}

function assertEvent(event) {
  if (
    event === null ||
    typeof event !== "object" ||
    typeof event.type !== "string" ||
    !Number.isSafeInteger(event.seq)
  ) {
    throw new Error("DSH session follow delivered an invalid event");
  }
}

/**
 * Correlates one `session/prompt` request with its durable Session turn.
 *
 * `session/follow` always opens with a persisted snapshot and then emits
 * gap-free events. Reopening after a transport failure supplies another
 * snapshot, so duplicate events are ignored by sequence number while a lost
 * persisted range is rejected rather than guessed.
 */
export class EventDrivenTurn {
  #requestId;
  #requireResponse;
  #lastSeq;
  #currentTurn;
  #requestTurn;
  #response;
  #completion;
  #snapshots = 0;
  #promptIssued = false;

  constructor(requestId, { requireResponse = true } = {}) {
    this.#requestId = requestId;
    this.#requireResponse = requireResponse;
  }

  get completion() {
    return this.#completion;
  }

  markPromptIssued() {
    this.#promptIssued = true;
  }

  accept(frame) {
    if (frame?.type === "snapshot") {
      this.#acceptSnapshot(frame);
      return this.#completion;
    }
    if (frame?.type === "event") {
      this.#acceptEvent(frame.event);
      return this.#completion;
    }
    // `assistant-stream` is deliberately not requested. Ignore an unexpected
    // transient frame so it cannot alter durable completion semantics.
    if (frame?.type === "assistant-stream") return this.#completion;
    throw new Error("DSH session follow delivered an invalid frame");
  }

  #acceptSnapshot(frame) {
    if (!Number.isSafeInteger(frame.cursor) || !Array.isArray(frame.records)) {
      throw new Error("DSH session follow delivered an invalid snapshot");
    }

    const records = frame.records
      .filter((record) => record?.type === "event")
      .map((record) => record.event);
    for (const event of records) assertEvent(event);
    records.sort((left, right) => left.seq - right.seq);

    if (this.#snapshots > 0 && this.#lastSeq !== undefined) {
      const firstFresh = records.find((event) => event.seq > this.#lastSeq);
      if (firstFresh !== undefined && firstFresh.seq !== this.#lastSeq + 1) {
        throw new Error("DSH session follow reconnect missed persisted events");
      }
      if (firstFresh === undefined && frame.cursor > this.#lastSeq) {
        throw new Error("DSH session follow reconnect omitted persisted events");
      }
    }

    this.#snapshots += 1;
    for (const event of records) this.#acceptEvent(event);
  }

  #acceptEvent(event) {
    assertEvent(event);
    if (this.#lastSeq !== undefined) {
      if (event.seq <= this.#lastSeq) return;
      if (event.seq !== this.#lastSeq + 1 && this.#promptIssued) {
        throw new Error("DSH session follow skipped a persisted event");
      }
    }
    this.#lastSeq = event.seq;

    if (event.type === "turn/start") {
      const turn = event.data?.turn;
      if (!Number.isSafeInteger(turn)) throw new Error("DSH turn/start has no turn number");
      this.#currentTurn = turn;
      return;
    }

    if (
      event.type === "user/message" &&
      event.data?.source?.rpcId === this.#requestId
    ) {
      if (!Number.isSafeInteger(this.#currentTurn)) {
        throw new Error("DSH request has no matching turn boundary");
      }
      this.#requestTurn = this.#currentTurn;
      return;
    }

    if (
      event.type === "assistant/message" &&
      event.data?.turn === this.#requestTurn
    ) {
      const text = textFromAssistantMessage(event);
      if (text !== undefined) this.#response = text;
      return;
    }

    if (event.type === "turn/end") {
      if (event.data?.turn === this.#requestTurn) {
        if (this.#requireResponse && this.#response === undefined) {
          throw new Error(`DSH turn ${this.#requestTurn} produced no final assistant text`);
        }
        this.#completion = {
          turn: this.#requestTurn,
          ...(this.#response === undefined ? {} : { response: this.#response }),
        };
      }
      if (event.data?.turn === this.#currentTurn) this.#currentTurn = undefined;
    }
  }
}
