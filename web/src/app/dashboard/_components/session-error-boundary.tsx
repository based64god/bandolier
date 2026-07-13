"use client";

import { Component, type ReactNode } from "react";

/**
 * Isolates the live transcript render (SubagentPanel + Conversation) of one
 * interactive session so a malformed ACP frame — a pathologically deep subagent
 * tool tree, an unexpected update shape — degrades to an inline notice instead of
 * throwing all the way up. Without it a single throw unmounts the whole dashboard
 * (there is no route-level error.tsx): every session's transcript AND composer
 * vanish, so "no messages can be sent or received." Scoped per row and placed
 * around only the transcript — the composer stays mounted as its sibling — so the
 * user can still type and send even when a session's transcript can't render.
 *
 * `resetKey` lets the parent clear a caught error when the underlying data
 * changes (e.g. the next poll brings frames that render): a changed key drops the
 * error state and re-attempts the children. Without it the boundary would stay
 * latched on the first bad frame for the life of the row.
 */
export class SessionErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey?: unknown },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.failed && !Object.is(prev.resetKey, this.props.resetKey)) {
      this.setState({ failed: false });
    }
  }

  componentDidCatch(error: unknown) {
    // Surface the failure for debugging without taking down the app.
    console.error("Interactive session transcript failed to render:", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
