import { useCallback, useEffect, useRef, useState } from "react";

import { decodeStreamFrame } from "../utils/streamFrames";
import type {
  StreamClientMode,
  StreamFrame,
  StreamInspect,
  StreamMeta,
  StreamStatus,
  StreamTextEnvelope,
} from "../types/stream";

export type StreamConnectionState = "idle" | "connecting" | "open" | "closed";

export type UseStreamTapOptions = {
  /** Topic without the `:endpoint` suffix; null closes the socket. */
  topic: string | null;
  mode: StreamClientMode;
  /** The client's pixel budget. The backend decimates to it. */
  columns: number;
  /** Seconds of signal the column budget spans; sets the decimation ratio. */
  windowSeconds: number;
  frameRateHz: number;
  /**
   * Called for every data frame, outside React's render cycle.
   *
   * Data frames arrive tens of times a second. Routing them through `useState`
   * would re-render the panel — and the topology page it lives on — at that
   * rate, so they go straight to the renderer instead and only the low-rate
   * metadata below is React state.
   */
  onFrame: (frame: StreamFrame) => void;
};

export type UseStreamTapResult = {
  connectionState: StreamConnectionState;
  meta: StreamMeta | null;
  status: StreamStatus | null;
  inspect: StreamInspect | null;
  error: string | null;
  /** Ask the backend to re-decimate to a new pixel budget. */
  setColumns: (columns: number) => void;
};

const RECONNECT_DELAY_MS = 1000;

function streamSocketUrl(
  topic: string,
  mode: StreamClientMode,
  columns: number,
  windowSeconds: number,
  frameRateHz: number
): string {
  const query = new URLSearchParams({
    topic,
    mode,
    columns: String(Math.round(columns)),
    window: String(windowSeconds),
    hz: String(frameRateHz),
  }).toString();

  const configuredBaseUrl = import.meta.env.VITE_WS_BASE_URL as string | undefined;
  if (configuredBaseUrl && configuredBaseUrl.length > 0) {
    return `${configuredBaseUrl.replace(/\/$/, "")}/ws/stream?${query}`;
  }
  if (import.meta.env.DEV) {
    return `ws://127.0.0.1:8000/ws/stream?${query}`;
  }
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/ws/stream?${query}`;
}

/**
 * Hold one `/ws/stream` socket open for as long as a topic is being watched.
 *
 * Deliberately one socket per panel rather than multiplexing every stream onto
 * the dashboard's existing `/ws/events` connection: a stream's lifetime is the
 * panel's, its backpressure is its own, and closing the panel must release the
 * tap in the backend. Sharing the events socket would tie all of that together
 * and make one stalled plot everyone's problem.
 */
export function useStreamTap(options: UseStreamTapOptions): UseStreamTapResult {
  const { topic, mode, columns, windowSeconds, frameRateHz, onFrame } = options;

  const [connectionState, setConnectionState] = useState<StreamConnectionState>("idle");
  const [meta, setMeta] = useState<StreamMeta | null>(null);
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [inspect, setInspect] = useState<StreamInspect | null>(null);
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  // Held in a ref so a changed callback identity does not tear down the socket;
  // panels rebuild this every render as the renderer instance changes.
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  // The initial pixel budget is a query parameter, but resizes must not
  // reconnect, so later changes go over the socket as a config message.
  const columnsRef = useRef(columns);
  const windowRef = useRef(windowSeconds);

  // Changing the window must not reconnect either; it goes over the socket for
  // the same reason a resize does.
  useEffect(() => {
    if (windowSeconds === windowRef.current) {
      return;
    }
    windowRef.current = windowSeconds;
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ kind: "stream.config", window_seconds: windowSeconds }));
    }
  }, [windowSeconds]);

  const setColumns = useCallback((nextColumns: number) => {
    const rounded = Math.max(1, Math.round(nextColumns));
    if (rounded === columnsRef.current) {
      return;
    }
    columnsRef.current = rounded;
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ kind: "stream.config", columns: rounded }));
    }
  }, []);

  useEffect(() => {
    if (!topic) {
      setConnectionState("idle");
      setMeta(null);
      setStatus(null);
      setInspect(null);
      setError(null);
      return undefined;
    }

    let disposed = false;

    const connect = () => {
      if (disposed) {
        return;
      }
      setConnectionState("connecting");
      const socket = new WebSocket(
        streamSocketUrl(topic, mode, columnsRef.current, windowRef.current, frameRateHz)
      );
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) {
          return;
        }
        setConnectionState("open");
        setError(null);
      };

      socket.onmessage = (event: MessageEvent) => {
        if (disposed) {
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          try {
            onFrameRef.current(decodeStreamFrame(event.data));
          } catch (frameError) {
            setError(frameError instanceof Error ? frameError.message : String(frameError));
          }
          return;
        }
        let envelope: StreamTextEnvelope;
        try {
          envelope = JSON.parse(String(event.data)) as StreamTextEnvelope;
        } catch {
          return;
        }
        switch (envelope.kind) {
          case "stream.meta":
            setMeta(envelope.data);
            break;
          case "stream.status":
            setStatus(envelope.data);
            break;
          case "stream.inspect":
            setInspect(envelope.data);
            break;
          case "stream.error":
            setError(envelope.data.message);
            break;
          default:
            break;
        }
      };

      socket.onclose = () => {
        if (disposed) {
          return;
        }
        setConnectionState("closed");
        // Retried rather than surfaced as a dead panel: the usual reason a
        // stream socket closes is the dashboard backend restarting, and a panel
        // that quietly resumes is better than one the user has to reopen.
        reconnectRef.current = window.setTimeout(connect, RECONNECT_DELAY_MS);
      };

      socket.onerror = () => {
        // `onclose` always follows, and carries the retry; reporting here as
        // well would only ever produce a message with no detail in it.
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectRef.current !== null) {
        window.clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onopen = null;
        socket.close();
      }
      setMeta(null);
      setStatus(null);
      setInspect(null);
    };
  }, [topic, mode, frameRateHz]);

  return { connectionState, meta, status, inspect, error, setColumns };
}
