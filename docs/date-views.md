# Date-arranged views — calendars, heatmaps and timelines


A monthly calendar, a habit heatmap and a Gantt chart look like three features.
They are one arrangement: **the same rows, placed by a date column.** Building
them separately is how a platform ends up with three bespoke surfaces and three
ejects; declaring the arrangement is how it ends up with one primitive and none.

Two ops declare it:

| Op | Block | What it draws |
| --- | --- | --- |
| `page.addCalendar` | `calendar` | a month grid, a week grid, or a density heatmap |
| `page.addTimeline` | `timeline` | bars across a start→end range, with dependency arrows |

A view **replaces** the page's list rather than sitting beside it — the block
says "these rows, arranged by this date", and rendering both is two answers to
one question.

```jsonc
// A weekly meal planner: recipes placed on the day they are cooked, movable.
{ "op": "page.addCalendar",
  "args": { "pageId": "pg-recipes", "blockId": "blk-recipes-planner",
    "calendar": { "dateField": "plannedFor", "display": "week",
                  "timezone": "America/Chicago", "titleField": "name",
                  "reschedule": true } } }

// A Gantt: start→due as the bar, a declared self-reference as the arrow.
{ "op": "page.addTimeline",
  "args": { "pageId": "pg-tasks", "blockId": "blk-tasks-timeline",
    "timeline": { "startField": "startDate", "endField": "dueDate",
                  "dependsOn": "blockedBy", "timezone": "America/New_York",
                  "reschedule": true } } }
```

Everything a view names is checked when the op lands, not when the page renders:
the field exists on the page's backing entity, a date column really is a `date`,
`dependsOn` really references its own entity, the display is a known one, and the
timezone is one this runtime's IANA database knows.

## The timezone is declared, never inferred

`timezone` is required. This is the one decision that produces the classic
calendar bug when it is left implicit:

- Bucket by the **server's** zone and the grid is wrong for everyone not in it.
- Bucket by the **browser's** and two people looking at one screen see two
  different grids — and the server-rendered HTML disagrees with the hydrated
  client.

So one function converts an instant to a day (`dayKeyOf(value, timezone)`), it
takes the zone as a required argument, and everything downstream is arithmetic on
`YYYY-MM-DD` day keys. The anchor day the grid is drawn around is resolved on the
server, in the declared zone, and travels in the URL (`?on=2026-08-05`) — so a
window is a link somebody can send.

## Which rows a window selects

A single-day calendar is a point per row, so a plain range on the date column
says exactly what the grid draws. Anything with a declared **end** column — a
multi-day calendar entry, every timeline bar — is a span, and a span needs a
different question: *does it overlap the window?*

That question cannot be asked with two range bounds. An entry that starts before
the window and ends inside it falls out of a range test on its start column
alone; adding a bound on the end column fixes that and silently drops every row
whose end is **NULL**, which is exactly the milestone rows a timeline
deliberately keeps drawing. Silently dropping a row is the worst failure a
calendar has, which is why these views read a capped 500 rows for as long as
they did rather than a window that lied.

`ListOptions.overlaps` asks it honestly, in one clause:

```
   (end IS NULL     AND start >= from AND start <= to)
OR (end IS NOT NULL AND start <= to   AND end   >= from)
```

The null branch is not a special case bolted on — a row with no end **is** a
point at its start, so it belongs in the window exactly when its start does.

### A timeline's axis

A timeline has no natural period the way a month grid does, so its window is
**chosen rather than declared**: a quarter (91 days) from the anchor's month
start, stepped by exactly that, with the same *Earlier / Today / Later* links
every calendar has. Before this the axis spanned whatever the capped row set
happened to contain, which meant the chart rescaled whenever a row moved and
"earlier" was not a place a viewer could go.

The axis and the query come from the same function call, so they cannot
disagree — a chart whose axis is derived from the rows that came back shows a
bar-shaped hole at one edge. A bar reaching past an edge is **clipped and marked
as continuing**; its accessible label still states the row's own dates, because
a screen reader told the edge of the window instead of the real end would be
told something untrue about the data.

**Zone-less values stay zone-less.** A spec `date` field is a `timestamp` without
time zone, so what the column reads back — `2026-03-08 09:00:00` — is a wall
clock, not an instant. Its date part *is* the day, in every zone; re-projecting
it would move the appointment by the offset. Only a value carrying an offset or a
`Z` is converted through the zone, because only that one names an instant.

## Moving an entry writes nothing new

`reschedule: true` makes entries movable — by drag, and equally by keyboard. What
a move produces is **field values**, not a write:

1. The view reports the row and the target day (`onMove`).
2. `rescheduleValues()` turns that into values for the view's **own declared date
   columns** and nothing else — a multi-day entry keeps its length, a timeline
   bar keeps its duration, a bare date stays a bare date.
3. Those values are submitted to the record's ordinary edit route, in the
   ordinary encoding — the same route and action `<DynamicForm>` posts to.

There is no reschedule endpoint. A drag therefore runs the identical validation,
permission check, tenant scoping and audit entry as editing that field in the
form, because it *is* that path. The property is structural rather than
promised, and `apps/web/app/reschedule.test.ts` drives it end to end: a
drag-shaped payload lands through `updateHandler`, and a bad value 422s with the
same `fieldErrors` a bad form submission gets.

A heatmap can never be rescheduled — a cell is a count, not an entry, so there is
no row a drop would rewrite. The op refuses the combination rather than ignoring
it.

## Keyboard, not drag-only

Every entry is a focus stop. With `reschedule` on, the arrow keys move the
focused entry: left/right by a day; up/down by a week in the month grid and by a
day in the week grid, where a row *is* a day. A timeline bar moves left/right,
carrying its end with it. Each move is announced in a live region, because the
result appears elsewhere on screen. Heatmap cells state their count in text as
well as shade, so the graph does not depend on discriminating colours.

## Where the line is drawn

A view is **presentation over declared data**. Everything below is deliberately
out of scope, and each one is still a live off-surface ask in the benchmark
corpus:

| Not this | Why | Corpus ask |
| --- | --- | --- |
| Streak / grace-day rules | today's answer depends on the whole ordered history, including days with no row | `ch-streak-freeze` |
| Rescheduling dependents, critical path | a scheduling rule, not a drawing; the timeline draws the arrow and stops | `ch-slip-cascade` |
| Recurring events | a rule standing in for rows that do not exist, with per-occurrence exceptions | `ch-repeating-meals` |

Drawing that line explicitly is the point: a chart component that grows a rules
engine is how a view primitive turns into a product nobody chose to build.

## Known limits

- **Every date view is windowed**, and each still reads under a
  1,000-row cap that is stated on screen when it is hit. The window bounds *how
  far* a view reads; the cap bounds *how many* rows one window may hold, and a
  thousand overlapping bars in a quarter is still a thousand rows. A truncated
  chart looks exactly like a complete one, so it says so.
- **A calendar arranges the rows of the page it is on.** A planning surface that
  wants to arrange a *related* entity's rows (meal plans showing recipes) puts
  the view on the related page instead.
- **`dependsOn` is one predecessor per row**, because that is what a declared
  reference field is. Fan-in is not modelled.
