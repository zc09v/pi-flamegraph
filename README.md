# pi-flamegraph

Record a **pi session life cycle** and render it as an **interactive flame graph** in a
self-contained HTML file. Hover any segment to see its duration, self time, and
start/end wall-clock times; click a segment to zoom in; use the search box to
highlight spans.

## What it captures

Every timed segment of the session, nested as:

```
session
└── agent run          (labeled with the user prompt preview)
    └── turn           (labeled with the tools it called, or a text preview)
        ├── request    (labeled with the HTTP status; time to response headers)
        ├── assistant  (model generation: provider/model + output text preview)
        └── tool       (tool name + args; result size and error flag on hover)
```

Timing is wall-clock, captured live via pi lifecycle events
(`session_start`/`agent_start`/`turn_start`/`message_start`/`tool_execution_start`
and their matching `*_end` events). Parallel tool calls are laid out on
separate rows so they never overlap.

## Install

```bash
# from a local path during development
pi install /absolute/path/to/pi-flamegraph

# or point pi at the repo / npm package once published
pi install git:github.com/you/pi-flamegraph
pi install npm:pi-flamegraph
```

Then restart pi (or `/reload`) and run a few prompts/tools.

## Usage

In an interactive pi session:

```bash
/flamegraph                 # writes ./flamegraph.html
/flamegraph out.html        # writes ./out.html
```

The agent can also generate it via the `generate_flamegraph` tool (optional
`outputPath` argument).

A snapshot is automatically written when the session ends to:

```
~/.pi/agent/flamegraph/<session-id>.html
~/.pi/agent/flamegraph/<session-id>.json
```

so timing data survives exit/reload and is restored for the same session.

## Reading the flame graph

- **Width** = wall-clock duration (relative to the current zoom root).
- **Collapse idle** = on by default; idle gaps between activity are compressed into thin striped markers so long-lived sessions stay readable. Toggle it to see true wall-clock spacing.
- **Rows** = segments that overlap in time are pushed to separate rows.
- **Colors** = segment category (see the legend in the HTML).
- **Hover** = name, category, duration, self time (with % of total), % of parent, start/end times, token usage + cost, HTTP status, stop reason, tool args / result size / error flag, and a per-node children breakdown.
- **Click** = zoom into a segment; the breadcrumb lets you zoom back out, or use **Reset zoom**.
- **Search** = highlight matching spans and dim everything else.

## Project layout

```
package.json               # pi-package manifest
extensions/flamegraph.ts   # extension: event capture + /flamegraph command + tool
extensions/renderer.ts     # self-contained HTML renderer (no external deps)
extensions/types.ts        # shared span/data types
```
