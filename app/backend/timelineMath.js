// Pure timeline arithmetic (no database): placeholder timing for spoken lines, and the edit operations'
// ripple / non-ripple rules. Kept separate so it can be tested exhaustively.

// A guess for how long a spoken line takes, used only until the real voice is approved (~15 characters a second).
export function audioDurationFallbackMs(text) {
  return Math.max(700, Math.round(String(text ?? "").length * 65));
}
