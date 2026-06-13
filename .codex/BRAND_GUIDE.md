# Word Sprint Brand Guide

This guide is for any AI agent or human contributor working on Word Sprint. Read it before changing UI, icons, buttons, copy, game visuals, animations, or interaction patterns.

## Brand Position

Word Sprint is a fast, social word-game app. It should feel sharp, competitive, compact, and a little celebratory, without becoming noisy or cartoonish.

The app is not a marketing site. It is a playable tool first. New screens should get players into the game quickly, show state clearly, and avoid long explanatory text.

Core adjectives:
- Fast
- Focused
- Competitive
- Friendly
- Tactile
- Polished

Avoid:
- Cute-for-cute's-sake styling
- Overly decorative layouts
- Heavy hero/landing-page patterns
- Gradients that dominate the whole interface
- Large blocks of instructional copy inside gameplay screens
- Unnecessary cards nested inside other cards

## Product Names And Modes

Use these names consistently:
- App: `Word Sprint`
- Solo mode: `Daily Challenge` in menu, `Daily Sprint` in results/leaderboard
- Classic two-player mode: `Sprint Duel`
- Tug mode: `Word Tug`
- Race mode: `Word Race`

Use `room` language only for multiplayer logistics:
- `Room`
- `Room code`
- `Copy`
- `Join Room`

## Voice And Copy

Copy should be short, direct, and game-state oriented.

Preferred style:
- `Tap Ready when you are set.`
- `Starting in 3.`
- `Sprint Duel started. Solve fast.`
- `Round 2. Fastest solve scores +1.`
- `Round 2. First solve scores +1.`
- `You won the tug`
- `Tester won the tug`
- `You won the race`
- `Tester won the race`

Avoid:
- Long rule explanations during gameplay
- Jokey or sarcastic messages
- Ambiguous verbs like `pulled` when `scored +1` is clearer
- Referring to internal implementation details like API, cache, service worker, or backend

When Word Tug reports a scored round, include the word:
- Good: `You scored +1 on CRANE. Round 2 begins.`
- Bad: `You pulled the rope.`

## Layout Principles

The app should feel like a compact game console:
- Keep gameplay centered.
- Keep controls close to the board.
- Use full-width bands or single panels, not nested cards.
- Use cards only for focused, bounded things: menu panel, opponent panel, result card, leaderboard.
- Keep repeated elements dense and scannable.
- Preserve the keyboard and board as the visual anchors.

Mobile is the primary layout target. Always check:
- Header does not crowd room code/timer.
- Board fits without horizontal scroll.
- Keyboard buttons remain tappable.
- Result popups do not sit behind the keyboard.
- Text does not overflow buttons or panels.

## Color System

Use the existing CSS tokens in `public/styles.css`. Do not introduce one-off colors unless adding a new token is clearly justified.

Dark theme tokens:
- Background: `--bg: #11130f`
- Panel: `--panel: #1d211a`
- Secondary panel: `--panel-2: #252a22`
- Text: `--text: #f4f1e8`
- Muted text: `--muted: #aeb3a8`
- Border line: `--line: #3c4238`
- Green/action/correct: `--green: #4f9d69`
- Blue/share/duel: `--blue: #5f8ee6`
- Gold/leaderboard/highlight: `--gold: #c6a44b`
- Accent/warm pressure: `--accent: #e85d3f`

Light theme has matching token names. Any new component must work in both themes by using tokens rather than hardcoded theme-specific values.

Semantic use:
- Green: primary positive action, correct tiles, ready/continue.
- Blue: share, join, Sprint Duel accents.
- Gold: leaderboard, Word Tug highlights, room codes, winner names, important status.
- Blue/green: Word Race lanes and progress; keep the finish-line state readable, not decorative.
- Muted: secondary copy and inactive states.
- Warm accent: sparingly, for pressure or warning moments.

Avoid purple/purple-blue gradients, beige-heavy palettes, and decorative color blobs. Background gradients should remain subtle and atmospheric.

## Typography

Use the existing system font stack:
`Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`

Rules:
- Keep letter spacing at `0`.
- Do not scale ordinary UI text with viewport width.
- Use heavy weights for game UI and labels.
- Reserve very large type for the main `Word Sprint` menu heading and major result moments.
- Keep panel headings compact.

Text should never overlap or require guessing. If a string can be long, constrain it with ellipsis or wrap intentionally.

## Shapes, Borders, And Depth

Default radius: `8px`.

Use:
- `8px` radius for panels, cards, buttons, inputs.
- Circular shapes only for countdown bubbles, marker dots, and icon-only round buttons.
- Thin borders using `--line`.
- Soft shadows for panels and result cards.

Avoid:
- Pill buttons except for existing theme toggle and room badge style.
- Deep nested card stacks.
- Large floating decorative containers.

## Buttons And Controls

Buttons should feel tactile and game-like:
- Minimum touch target: `44px` where practical.
- Use `touch-action: manipulation` for tappable controls.
- Use existing button classes: `.button-green`, `.button-blue`, `.button-mustard`, `.text-button`.
- Disabled buttons should remain visible but clearly inactive.

Mode buttons:
- Daily Challenge: green
- Sprint Duel: blue
- Word Tug: gold/mustard
- Word Race: blue
- Leaderboard: gold/mustard

Icon-only buttons:
- Use familiar symbols or an icon library if one is already installed.
- Back buttons may use the existing arrow.
- Add accessible labels.

Do not create text-filled rounded UI where a standard icon would be clearer, unless the command needs text to avoid ambiguity.

## Game Board And Keyboard

The Wordle-style board and keyboard are core brand assets.

Keep:
- Square tiles.
- Strong letter weight.
- Green/yellow/dark evaluation colors.
- Compact key spacing.
- Stable board dimensions during typing/evaluation.

Keyboard:
- Must remain visible and tappable on mobile.
- Do not let overlays permanently block it unless the game is over.
- Avoid browser zoom problems: keep `touch-action: manipulation` on buttons and page.

## Multiplayer Patterns

Rooms should have clear status before any input is allowed.

Sprint Duel:
- Both players must join.
- Both players tap Ready.
- Countdown starts only after both are ready.
- Guessing is blocked until countdown ends.
- Copy should say `Sprint Duel started. Solve fast.` after countdown.

Word Tug:
- Both players must join.
- Both players tap Ready before round 1.
- Countdown starts only after both are ready.
- Every new Tug game should use a fresh random sequence of words.
- Rounds reset immediately after either player solves the current word.
- Match ends at `+3`.
- The Tug meter must map actual score from `-3` to `+3`; `+2` is close, not maxed.

Word Tug end popup:
- Show centered winner message.
- Winner view: `🥳 You won the tug`.
- Losing view: `🤕 PlayerName won the tug`.
- Highlight winner name in gold.
- Do not show `3 / -3` score tiles; the final score is implied.
- Leaderboard action must clear overlay blur before showing leaderboard.

Word Race:
- Both players must join.
- Both players tap Ready before round 1.
- Countdown starts only after both are ready.
- Every new Race game should use a fresh random sequence of words.
- Scores are positive only.
- First solve in a round scores `+1`.
- If one player uses all 6 attempts without solving, the opponent scores `+1`.
- Rounds reset immediately after any score.
- Match ends when a player reaches `5`.
- Show each player with their own left-to-right lane meter.
- Use the racecar emoji `🏎️` as the moving marker and `🏁` as the finish line.
- Keep Race meters compact on mobile so board and keyboard remain visible without scrolling where practical.

Word Race end popup:
- Show centered winner message.
- Winner view: `🥳 You won the race`.
- Losing view: `🤕 PlayerName won the race`.
- Highlight winner name in gold.
- A final score summary is acceptable because Race may end `5-0`, `5-4`, or anything between.

## Leaderboards

Leaderboard views should be table-like, dense, and scannable.

Daily Sprint:
- Focus on points, attempts, and best time.

Sprint Duel:
- May use the existing point/time scoring pattern.

Word Tug:
- Do not use points.
- Show wins, losses, and win percentage.
- Sort by wins first, then win percentage.

Tabs:
- `Daily`
- `Duel`
- `Word Tug`

## Animation And Motion

Motion should be fast and purposeful:
- Tile row feedback can pop/shake.
- Countdown can pulse.
- Tug marker can slide.
- Result overlay may appear instantly or with subtle motion.

Avoid:
- Long decorative animations.
- Motion that delays input.
- Large background motion.

Respect `prefers-reduced-motion`.

## Icons And Emoji

Use emoji sparingly for game feedback, not as decoration.

Approved current emoji:
- Word Tug neutral/pressure meter: existing mood emoji are acceptable.
- Winner popup: `🥳`
- Losing popup: `🤕`
- Trophy/win state: `🏆` where already used.
- Word Race marker: `🏎️`
- Word Race finish line: `🏁`

Do not add random mascots, creatures, or decorative emoji.

## Accessibility

Baseline requirements:
- Keep buttons keyboard accessible.
- Use `aria-live` for changing game status where already present.
- Maintain readable contrast in dark and light themes.
- Every icon-only button needs an accessible label.
- Do not rely on color alone for critical result state; text should also describe it.

## Implementation Rules For Future Agents

Before UI changes:
1. Read this file.
2. Inspect existing `public/styles.css` and reuse tokens/classes.
3. Check both `index.html` and `public/index.html` when changing markup.
4. Bump `VERSION`, `package.json`, both HTML asset query strings, and both service worker cache names when changing shipped UI.
5. Test with the bundled Node runtime when available.
6. Browser-check mobile-relevant UI changes in the in-app browser or Playwright.

Do not:
- Put temporary handoff/session files in the git root.
- Leave generated leaderboard/test data in `data/leaderboard.json`.
- Introduce unrelated refactors while making UI adjustments.
- Commit unless the user asks.

## Quick QA Checklist

For any UI/gameplay change, verify:
- App loads with the new visible version badge.
- Daily Challenge still starts.
- Sprint Duel create/join/ready/countdown works.
- Word Tug create/join/ready/countdown works.
- Word Tug random words differ across sessions where practical.
- Word Race create/join/ready/countdown works.
- Word Race scores on solve, awards opponent on 6 misses, resets rounds, and ends at 5.
- Result popups fit on mobile.
- Leaderboard tabs render and do not leave blur overlays.
- Keyboard remains tappable and stable.
- No text overflows on mobile.
