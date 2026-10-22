/**
 * opencode-clm TUI plugin: the `/clm` panel (context size, input, edits, settings).
 * Loaded from `tui.json` (`exports["./tui"]`); the server plugin is index.ts.
 */
import { tui } from "./src/tui/plugin.ts";

// OpenCode 2 validates TUI modules as {id, setup} and calls setup; the panel is not ported yet
// (PORTING.md), so setup is a no-op there. OpenCode 1 ignores it and calls `tui`.
export default { id: "opencode-clm", tui, setup: async () => {} };
