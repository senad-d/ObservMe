# Configuration TUI Design Template

## Purpose

This document defines a reusable visual standard for a terminal-based configuration interface. It describes only how the interface should look and behave visually. It does not define any product-specific content, setting names, configuration keys, file paths, or implementation details.

## Design Goal

Create a compact, polished, keyboard-driven configuration screen with:

- A framed terminal-panel appearance.
- A clear category area and setting-detail area.
- Strong visual focus states.
- Right-aligned setting values.
- Minimal but complete keyboard help.
- Responsive behavior for wide, narrow, and tiny terminal widths.
- Consistent colors through theme roles instead of hardcoded colors.

## Core Visual Principles

- The interface must feel like a structured control panel, not a free-form list.
- Use a monospaced terminal grid.
- Use Unicode box-drawing characters for normal-width layouts.
- Use clean spacing and alignment over decoration.
- Use one selection marker everywhere: `▶ `.
- Use one footer/status separator everywhere: ` • `.
- Use short, readable labels.
- Keep help text compact and predictable.
- Never allow rendered lines to exceed the terminal width.

## Theme Roles

Use semantic theme roles consistently.

| UI Element | Theme Role |
| --- | --- |
| Outer border | `accent` |
| Pane separators | `accent` |
| Focused selected prefix | `accent` |
| Focused selected label | `accent` + bold |
| Unfocused selected prefix | `muted` |
| Unfocused selected label | `muted` |
| Unselected category label | `dim` |
| Counter text | `dim` |
| Helper text | `dim` |
| Empty value | `dim` |
| Disabled/off value | `dim` |
| Enabled/on value | `success` |
| Warning/no-match text | `warning` |
| Slider bar | `accent` |

Rules:

- Do not hardcode ANSI color values.
- Apply styling through theme roles only.
- Selected text in the active pane is bold.
- Selected text in an inactive pane is not bold.
- Unselected setting labels use normal text.
- Unselected category labels are dimmed.

## Responsive Width Modes

### Wide Mode

Use wide mode when terminal width is at least `72` columns.

Wide mode shows two panes:

- Left pane: categories.
- Right pane: settings for the selected category or search results.

Width calculation:

```text
leftPaneWidth  = min(22, max(16, floor(totalWidth * 0.27)))
rightPaneWidth = max(10, totalWidth - leftPaneWidth - 3)
```

The `3` reserved columns are:

```text
left border + middle divider + right border
```

Minimum body height:

```text
bodyHeight = max(categoryRowCount, settingsRowCount, 8)
```

Wide layout skeleton:

```text
╭─ Configuration ───────────────────────────────────── Scope ─╮
│writes <target> • external overrides may apply               │
│↑↓ move  Tab pane  Enter edit  / search  Esc back  q quit    │
├──────────────────────┬──────────────────────────────────────┤
│▶ Category            │SECTION TITLE                      1/6│
│  Category            │▶ Setting label                 value │
│  Category            │  Setting label                 value │
│                      │  Setting label                 value │
├──────────────────────┴──────────────────────────────────────┤
│1/6 • Description of the selected setting                    │
╰─────────────────────────────────────────────────────────────╯
```

### Narrow Mode

Use narrow mode when terminal width is from `24` to `71` columns.

Narrow mode shows one pane at a time:

- Category view when categories are focused.
- Settings view when a category is opened or search is active.

Narrow category-view skeleton:

```text
╭─ Configuration ───────────────── Scope ─╮
│writes <target> • external overrides...  │
│↑↓ category  Enter open  / search  q quit│
├─────────────────────────────────────────┤
│▶ Category                               │
│  Category                               │
│  Category                               │
├─────────────────────────────────────────┤
│1/3 • Category description               │
╰─────────────────────────────────────────╯
```

Narrow settings-view skeleton:

```text
╭─ Configuration ───────────────────────────── Scope ─╮
│writes <target> • external overrides...              │
│↑↓ move  Enter edit  Esc categories  / search  q quit│
├─────────────────────────────────────────────────────┤
│SECTION TITLE                                    1/6 │
│▶ Setting label                                value │
│  Setting label                                value │
├─────────────────────────────────────────────────────┤
│1/6 • Selected setting description                   │
╰─────────────────────────────────────────────────────╯
```

### Tiny Mode

Use tiny mode when terminal width is less than `24` columns.

Tiny mode has no box border.

Tiny layout:

```text
Configuration
Scope
Selected label: value
q quit
```

Rules:

- Render exactly the essential information.
- Clip every line to terminal width.
- Do not draw borders.
- Do not attempt pane layout.

## Outer Frame

The normal-width interface uses a single outer frame.

### Top Border

Top border pattern:

```text
╭─ Configuration ───────────────────── Scope ─╮
```

Construction rules:

- Left corner: `╭`
- Right corner: `╮`
- Horizontal line: `─`
- Title begins after the first horizontal segment.
- Scope label appears on the right side.
- Fill available space between title and scope with `─`.
- Entire line uses the `accent` role.
- If space is limited, truncate the inner title/scope text and pad to fit exactly.

### Bottom Border

Bottom border pattern:

```text
╰────────────────────────────────────────────╯
```

Construction rules:

- Left corner: `╰`
- Right corner: `╯`
- Fill with `─`.
- Entire line uses the `accent` role.
- Visible width equals terminal width.

### Full-Width Interior Lines

Interior line pattern:

```text
│content padded to inner width│
```

Rules:

- Left and right borders are `│`.
- Border characters use `accent`.
- Inner content width is `totalWidth - 2`.
- Content is clipped and then right-padded.

## Header Area

The header area contains two full-width lines below the title border.

### Source/Target Line

Pattern:

```text
writes <target> • external overrides may apply
```

Rules:

- Start with `writes `.
- Show the active write target or configuration source generically.
- Use ` • ` before the override note.
- If the target text is long, preserve the tail with a leading ellipsis.
- Keep the text plain; do not over-style this line.

### Keyboard Help Line

Wide mode:

```text
↑↓ move  Tab pane  Enter edit  / search  Esc back  q quit
```

Narrow category mode:

```text
↑↓ category  Enter open  / search  q quit
```

Narrow settings mode:

```text
↑↓ move  Enter edit  Esc categories  / search  q quit
```

Rules:

- Use two spaces between command groups.
- Use plain text.
- Do not add extra icons.
- Clip and pad to fit.

## Pane Separators

### Wide Separators

Top pane separator:

```text
├──────────────┬────────────────────────┤
```

Bottom pane separator:

```text
├──────────────┴────────────────────────┤
```

Rules:

- Use `┬` between panes on the top separator.
- Use `┴` between panes on the bottom separator.
- Use `├` and `┤` at the sides.
- Use `─` for horizontal fill.
- Entire separator uses `accent`.

### Narrow Separators

Pattern:

```text
├───────────────────────────────────────┤
```

Rules:

- No middle divider.
- Entire separator uses `accent`.
- Width matches terminal width.

## Category Pane

The category pane is a vertical list of navigation choices.

### Row Structure

```text
<prefix><label>
```

Prefix rules:

| State | Prefix |
| --- | --- |
| Selected | `▶ ` |
| Not selected | `  ` |

### Selected Category Styling

When the category pane has focus:

```text
▶ Category
```

- Prefix: `accent`
- Label: `accent` + bold

When the category pane does not have focus:

```text
▶ Category
```

- Prefix: `muted`
- Label: `muted`
- Not bold

### Unselected Category Styling

```text
  Category
```

- Prefix: plain spaces
- Label: `dim`

### Category Row Sizing

- Prefix consumes exactly 2 visible columns.
- Label uses remaining pane width.
- Long labels are clipped with an ellipsis.
- Entire row is padded to pane width.

## Settings Pane

The settings pane contains:

1. A section header row.
2. Setting rows.
3. Optional empty/no-match row.

## Settings Section Header

Header pattern:

```text
SECTION TITLE                                  1/6
```

Rules:

- Section title is uppercase.
- Section title is bold.
- Section title is `accent` when settings pane is focused.
- Section title is `dim` when settings pane is not focused.
- Counter is always `dim`.
- Counter is right-aligned.
- At least one space separates title and counter.
- If there are no settings, use `0/0`.

Search header pattern:

```text
SEARCH QUERY                                  1/4
```

Rules:

- Prefix with `SEARCH `.
- Uppercase the full search title.

## Setting Rows

### Row Structure

Each setting row contains:

```text
<prefix><label column><space><value column>
```

Width formula:

```text
valueWidth = max(0, min(28, floor(paneWidth * 0.4)))
labelWidth = max(1, paneWidth - 2 - 1 - valueWidth)
```

Example:

```text
▶ Setting label                  value
  Another setting                  ON
```

Rules:

- Prefix consumes exactly 2 visible columns.
- Label column is left-aligned.
- Value column is right-aligned.
- One visible space separates label and value.
- Long labels are clipped.
- Long values are clipped according to their value type.

### Selected Setting Styling

When the settings pane has focus:

- Prefix: `accent`
- Label: `accent` + bold

When the settings pane does not have focus:

- Prefix: `muted`
- Label: `muted`
- Not bold

### Unselected Setting Styling

- Prefix: plain spaces
- Label: normal text
- Value: styled according to value type

## Search Result Rows

When search is active, setting labels include their category or group context.

Pattern:

```text
Setting label (Category)
```

Rules:

- Append context in parentheses.
- Clip the combined label if needed.
- Keep the same value alignment.

## Maximum Visible Setting Rows

Show at most `10` setting rows below the section header.

Rules:

- If there are 10 or fewer settings, show all.
- If there are more than 10 settings, show a moving window.
- Keep the selected setting visible.
- Prefer centering the selected setting when possible.
- Do not show a scrollbar in the main settings pane.
- Use the header counter as the position indicator.

## Empty Results State

When no settings are available or no search result matches:

```text
  No matching settings
```

Rules:

- Prefix with two spaces.
- Use `warning` color.
- Keep the section header visible above it.
- Show counter as `0/0`.

## Value Display Standards

Values appear in the right-aligned value column.

### Empty Values

Examples:

```text
not set
<empty>
auto
```

Rules:

- Use a meaningful empty label.
- Color empty values with `dim`.
- Clip if necessary.

### Boolean Values

Use uppercase labels:

```text
ON
OFF
```

Rules:

- Enabled value: `ON` with `success`.
- Disabled value: `OFF` with `dim`.
- Do not use checkboxes for boolean values in the main settings list.

### Text Values

Rules:

- Display mapped labels when available.
- Otherwise display the sanitized raw value.
- Clip with an ellipsis if too long.

### Number Values

Rules:

- Display as compact text.
- Right-align in the value column.
- Do not add units unless the setting label or value label requires it.

### Path-Like Values

Use tail-preserving truncation.

Example:

```text
…/folder/final-name.ext
```

Rules:

- If the value fits, show it unchanged.
- If too long, show `…` plus the end of the value.
- Preserve the most specific final segment.

### Slider Values

Slider pattern:

```text
[████░░░░] 0.45
```

Rules:

- Use `█` for filled segments.
- Use `░` for empty segments.
- Enclose the bar in square brackets.
- Color the bar with `accent`.
- Show the numeric value after one space.
- Slider bar width is between 3 and 10 cells.
- If space is too narrow, show only the numeric value.

## Footer

The footer is a single full-width interior line above the bottom border.

### Normal Footer

Pattern:

```text
1/6 • Selected setting description
```

### Footer With Status

Pattern:

```text
Saving setting… • 1/6 • Selected setting description
```

### Footer With Search

Pattern:

```text
Search: query • 1/4 • Selected setting description
```

If search is active but empty:

```text
Search: type to filter all settings • 1/6 • Selected setting description
```

Rules:

- Use ` • ` between footer segments.
- Status text takes priority over search text.
- Use selected setting description when a setting is selected.
- Use selected category/group description when no setting is selected.
- Clip and pad the full footer line to available width.

## Editing State Footer

For capture-style inputs, use a footer pattern like:

```text
1/6 • Press desired key or key combination • Enter save • Esc cancel
```

After a value is captured:

```text
1/6 • Captured <value> • Enter save • Esc cancel
```

Rules:

- Keep the same footer line position.
- Do not open a separate dialog for simple capture states.
- The selected row should remain visible.

## Search Behavior Visuals

Search changes scope but not the visual structure.

Rules:

- Activating search moves focus to settings.
- The title scope becomes `Search` only after a query exists.
- The section header becomes `SEARCH <QUERY>`.
- Result labels include their category/group in parentheses.
- Empty results use the warning no-match row.
- Clearing search returns to normal category/settings scope.

## Focus Behavior Visuals

Rules:

- Only one pane is focused at a time.
- Focus is shown through selected-row color and boldness.
- The inactive pane may still show its selected row, but muted.
- Focus must be understandable without relying only on cursor position.

Recommended initial state:

- Category pane focused.
- First category selected.
- First setting in each category remembered independently.

## Selector Dialog Style

Use this style for nested selection lists or submenus.

Structure:

```text
╭────────────────────────────────────────────────────────╮
│ Select value                                           │
│ Helper text explaining markers                         │
│ ▶ Option label                                         │
│   Option label                                         │
│ ↑↓ navigate • type to search • enter select • esc back │
╰────────────────────────────────────────────────────────╯
```

Rules:

- Use the same `accent` border style.
- Title is `accent` + bold.
- Helper text is `dim`.
- Selected option uses `accent`.
- Descriptions use `muted`.
- Scroll information uses `dim`.
- No-match text uses `warning`.
- Selector height should be capped at 16 visible options.

Optional availability markers:

```text
✓ Available option
○ Missing option
```

Rules:

- Use `✓` for available/found/installed items.
- Use `○` for missing/unavailable/not installed items.
- Do not use these markers in the main settings list unless the row value itself requires it.

## Text Safety Rules

Every renderer must follow these rules:

- No line may exceed the terminal width.
- Use ANSI-aware width calculations.
- Clip long content safely.
- Pad after clipping, not before.
- Sanitize terminal control sequences from all external text.
- Reapply styles per line.
- Do not rely on styling carrying across lines.

## Content Independence Rules

This design template controls appearance only.

Allowed to customize:

- Product title.
- Scope label.
- Category labels.
- Category descriptions.
- Setting labels.
- Setting descriptions.
- Setting values.
- Value labels.
- Empty labels.
- Search source.
- Save behavior.

Must remain consistent to preserve the design:

- Border characters.
- Breakpoints.
- Pane width formulas.
- Selection marker `▶ `.
- Footer separator ` • `.
- Right-aligned value column.
- Color role mapping.
- Focus styling.
- Maximum visible setting rows.
- Tiny fallback layout.
- Selector dialog visual style.

## Acceptance Criteria

A configuration TUI follows this template when:

- Wide screens use the two-pane framed layout.
- Narrow screens use the one-pane framed layout.
- Tiny screens use the no-border four-line fallback.
- Category and setting selections use the same marker and focus colors.
- Values are right-aligned and styled by value type.
- Footer text uses the same segment structure.
- Search state preserves the same frame and row layout.
- Selector dialogs visually match the main TUI language.
- All rendered lines fit the terminal width.
- No product-specific content is required by the template.
