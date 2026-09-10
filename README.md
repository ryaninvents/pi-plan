# Pi Plan Extension (`@devkade/pi-plan`)

An extension for the [Pi coding agent](https://github.com/badlogic/pi-mono/) that adds planning and execution-assist commands:

- **Default mode:** execute directly (YOLO)
- **Plan mode:** read-only investigation + concrete execution plan
- **/todos:** check current tracked plan progress
- **Execution starts only after approval** from the plan-mode UI prompt
- **Hand off to a fresh session** on a model of your choice, with the plan saved to disk

```txt
/plan on
/plan Refactor command parser to support aliases
```

---

## Why

Sometimes you want speed, sometimes you want safety.

This extension gives both:

- **No global slowdown** in normal workflows (default remains execution-first)
- **Structured planning mode** only when you request it
- **Read-only guardrails** while planning (tool + shell protections)
- **Explicit approval handoff** before implementation begins

---

## Install

### From npm

```bash
pi install npm:@devkade/pi-plan
```

### From git

```bash
pi install git:github.com/devkade/pi-plan@main
# or pin a tag
pi install git:github.com/devkade/pi-plan@v0.2.1
```

### Local development run

```bash
pi -e ./src/index.ts
```

---

## Quick Start

### 1) Start planning mode

```txt
/plan on
```

Then ask your task in the same session:

```txt
Implement release-note generator with changelog validation
```

### 2) One-shot plan command

```txt
/plan Implement release-note generator with changelog validation
```

This enables plan mode (if needed) and immediately sends the task.

### 3) Approve or continue planning

After each response in UI mode, you’ll get:

- **Approve and execute now**
- **Switch model, clear history, and execute** *(see [Handoff](#handoff))*
- **Continue from proposed plan** *(inline note optional; press `Tab` to add/edit. If omitted, Pi asks for modification input and waits.)*
- **Regenerate plan** *(fresh plan from scratch, no note required)*
- **Exit plan mode**

Choosing **Approve and execute now** automatically:
1. exits plan mode,
2. restores normal tools,
3. triggers implementation.

---

## Handoff

Long planning conversations make expensive context for the implementation that follows, and the model that plans well is not always the model you want writing the code. **Switch model, clear history, and execute** hands the plan off instead of continuing in place:

1. A standalone plan document is written from the **whole** planning conversation — constraints you gave, approaches that were rejected, file paths discovered while investigating — not just the final proposal.
2. It is saved to `$PI_CODING_AGENT_DIR/plans/<timestamp>-<slug>.md` (default `~/.pi/agent/plans/`), and the path is printed.
3. A searchable model picker opens. Type to filter; `Esc` aborts the handoff, leaving the saved file and your planning session untouched.
4. Pi starts a new session on the selected model and pre-fills the editor with a one-sentence description of the task and `Implement the plan described in <path>`.

Review the prompt and press Enter to start. The new session carries the plan file, not the transcript.

---

## Modes

| Mode | Behavior | Safety policy |
|---|---|---|
| Default (YOLO) | Executes directly unless you explicitly request planning | No extra restrictions |
| Plan (`/plan`) | Gathers evidence and returns an execution plan | Read-only tools + mutating action blocks |

---

## Plan-Mode Guardrails

### Tool restrictions

In plan mode:

- Mutating tools are blocked: `edit`, `write`, `ast_rewrite`
- Active tools are switched to a read-only subset when available

### Bash restrictions

`bash` commands are filtered through a read-only policy:

- ✅ inspection commands (examples): `ls`, `cat`, `grep`, `find`, `git status`, `git log`
- ❌ mutating commands (examples): `rm`, `mv`, `npm install`, `git commit`, redirection writes (`>`, `>>`)

---

## Plan Output Contract

In plan mode, the system prompt enforces this structure:

1. Goal understanding
2. Evidence gathered (files/symbols/docs checked)
3. Uncertainties / assumptions
4. Plan (step objective, target files/components, validation)
5. Risks and rollback notes
6. End with: `Ready to execute when approved.`

---

## Commands

### Plan workflow

- `/plan` — toggle plan mode on/off
- `/plan on` — enable plan mode
- `/plan off` — disable plan mode
- `/plan status` — show current status
- `/plan <task>` — enable mode if needed and start planning for `<task>`
- `/todos` — show tracked plan progress (`✓`/`○`) from extracted `Plan:` steps and `[DONE:n]` markers
- after each planning turn, the plan-mode action menu includes:
  - `Switch model, clear history, and execute` *(saves the plan to `$PI_CODING_AGENT_DIR/plans/`, then starts a new session on a model you pick — see [Handoff](#handoff))*
  - `Continue from proposed plan` *(inline note optional via `Tab`; without note, Pi prompts for modification input and waits)*
  - `Regenerate plan` *(no additional note required)*

## Development

```bash
npm install
npm run check
```

`npm run check` runs TypeScript type-checking (`tsc --noEmit`).

This extension targets `@earendil-works/pi-coding-agent` (the current Pi package; earlier releases were published as `@mariozechner/pi-coding-agent`).

---

## Project Structure

- `src/index.ts` - plan mode orchestration, `/todos`, and command wiring
- `src/plan-action-ui.ts` - the post-turn next-action menu
- `src/plan-handoff.ts` - plan document synthesis, file writing, and session handoff
- `src/model-picker-ui.ts` - searchable model picker used by the handoff
- `src/utils.ts` - read-only bash checks + plan step extraction/progress helpers
- `plan.md` - package-level feature plan notes
- `.github/workflows/ci.yml` - CI checks
- `.github/workflows/release.yml` - tag-triggered npm publish + GitHub Release

---

## Release

The release workflow runs on tags matching `v*.*.*` and performs:

1. `npm ci`
2. `npm run check`
3. tag/version consistency check
4. `npm publish --access public --provenance`
5. GitHub Release creation

Example:

```bash
npm version patch
git push origin main --tags
```
