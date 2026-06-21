# Sentinel Protocol — Investor Pitch

Source-of-truth pitch materials for fundraising conversations. Separate from `frontend/public/presentation/` (which is the hackathon demo deck for judges).

## Files

| File | Audience | Purpose |
|---|---|---|
| `slides.html` | Live pitching | Self-contained HTML deck — open in any browser. Keyboard nav (←/→, space, 1–9 to jump, Home/End). 16 slides matching `deck.md` 1:1. |
| `deck.md` | Pre-read / editing | Markdown source-of-truth for the deck. Each slide's "Talk track" lives here, not in the HTML. |
| `memo.md` | Follow-up after first meeting | Investment memo — mirrors the deck section-for-section. Sources cited inline. The document a partner forwards to their IC. |

All three are aligned 1:1 — Slide N in `slides.html` ↔ Slide N in `deck.md` ↔ Section N in `memo.md`.

## Opening the deck

```bash
# macOS
open pitch/slides.html

# or just double-click the file in Finder
```

The deck is a single HTML file with no build step and no dependencies (fonts pull from Google Fonts at load time). Keyboard shortcuts:
- `←` / `→` or `space` — prev / next slide
- `1`–`9` — jump to slide N
- `Home` / `End` — first / last slide

## How to use

1. **First investor meeting** — send `deck.md` (or its slide-tool export) ahead of time. Walk through it live.
2. **After the meeting** — send `memo.md` so the partner has the substance to build their IC memo on top of.
3. **Updates** — both files are markdown; treat them like code. Edit, commit, share the latest commit.

## Why two documents

A deck without a memo loses every comparison against a competitor that brought both. Investors juggle dozens of conversations — the one with the full written package is the one their colleagues can actually evaluate.

The deck is the teaser. The memo is the proof.

## References

- a16z 10-slide deck structure — <https://www.inknarrates.com/post/andreessen-horowitz-pitch-deck-guidelines>
- "Your pitch deck isn't enough" (memo template) — <https://speedrun.substack.com/p/your-pitch-deck-isnt-enough>
