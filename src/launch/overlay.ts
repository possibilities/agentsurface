type OpenTui = typeof import("@opentui/core");

/**
 * A centered filterable list overlay on `panel` with a single-line border —
 * the one place a full box is containment rather than decoration. It is the
 * anatomy the fleet's command palette prescribes, generalized one notch so
 * the launcher's project picker is the same instrument with another title.
 * Fleet convention keeps the implementation local to each repository.
 */

export interface OverlayItem {
  id: string;
  /** Bracketed accent key combo; omit for list items that have none. */
  key?: string;
  /** Muted trailing metadata, separated with a quiet dot. */
  meta?: string;
  label: string;
  onRun(): void;
}

export interface OverlayState {
  items: readonly OverlayItem[];
  width: number;
  height: number;
}

export interface OverlayTokens {
  panel: string;
  line: string;
  accent: string;
  muted: string;
  text: string;
}

export interface ListOverlay {
  root: InstanceType<OpenTui["BoxRenderable"]>;
  isOpen(): boolean;
  /** Opens with the selection on `at` — the row already applied, usually. */
  open(at?: number): void;
  close(): void;
  /** Keys reach it only while open; ctrl+c always falls through. */
  handleKey(key: {
    name: string;
    ctrl: boolean;
    meta?: boolean;
    sequence?: string;
    eventType?: string;
  }): boolean;
  update(state: OverlayState): void;
}

/** Case-insensitive substring filter over "label key meta". Pure for tests. */
export function overlayMatches(items: readonly OverlayItem[], filter: string): OverlayItem[] {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return [...items];
  return items.filter((item) =>
    `${item.label} ${item.key ?? ""} ${item.meta ?? ""}`.toLowerCase().includes(needle),
  );
}

const MAX_VISIBLE_ROWS = 10;

export function createListOverlay(
  core: OpenTui,
  renderer: Awaited<ReturnType<OpenTui["createCliRenderer"]>>,
  id: string,
  tokens: OverlayTokens,
  options: { title: string; empty: string },
): ListOverlay {
  let open = false;
  let filter = "";
  let selected = 0;
  let start = 0;
  let state: OverlayState = { items: [], width: 80, height: 24 };
  let signature = "";

  const root = new core.BoxRenderable(renderer, {
    id,
    position: "absolute",
    zIndex: 100,
    visible: false,
    flexDirection: "column",
    border: true,
    borderStyle: "single",
    borderColor: tokens.line,
    backgroundColor: tokens.panel,
    title: options.title,
    titleColor: tokens.muted,
    titleAlignment: "left",
    paddingLeft: 2,
    paddingRight: 2,
    onMouseScroll: (event) => {
      const direction = event.scroll?.direction;
      if (direction !== "up" && direction !== "down") return;
      moveSelection(direction === "down" ? 1 : -1);
      event.preventDefault();
    },
  });
  const filterText = new core.TextRenderable(renderer, {
    id: `${id}-filter`,
    content: "",
    height: 1,
    wrapMode: "none",
  });
  const rowsBox = new core.BoxRenderable(renderer, {
    id: `${id}-rows`,
    flexDirection: "column",
    marginTop: 1,
    backgroundColor: tokens.panel,
  });
  root.add(filterText);
  root.add(rowsBox);

  const matches = (): OverlayItem[] => overlayMatches(state.items, filter);

  const moveSelection = (delta: number): void => {
    const count = matches().length;
    if (count === 0) return;
    selected = Math.min(count - 1, Math.max(0, selected + delta));
    layout();
    renderer.requestRender();
  };

  const run = (item: OverlayItem): void => {
    close();
    item.onRun();
  };

  const openOverlay = (at?: number): void => {
    open = true;
    filter = "";
    selected = at !== undefined && at >= 0 ? at : 0;
    start = 0;
    root.visible = true;
    layout();
    renderer.requestRender();
  };

  const close = (): void => {
    open = false;
    root.visible = false;
    renderer.requestRender();
  };

  function layout(): void {
    const visible = matches();
    selected = Math.min(selected, Math.max(0, visible.length - 1));
    const width = Math.max(24, Math.min(56, state.width - 4));
    const rowCount = Math.min(
      Math.max(1, visible.length),
      Math.max(3, state.height - 8),
      MAX_VISIBLE_ROWS,
    );
    if (selected < start) start = selected;
    if (selected >= start + rowCount) start = selected - rowCount + 1;
    start = Math.max(0, Math.min(start, Math.max(0, visible.length - rowCount)));
    const height = rowCount + 4;
    root.width = width;
    root.height = height;
    root.left = Math.max(0, Math.floor((state.width - width) / 2));
    root.top = Math.max(1, Math.floor((state.height - height) / 3));

    const window = visible.slice(start, start + rowCount);
    const keyWidth = state.items.reduce((max, item) => Math.max(max, item.key?.length ?? 0), 0);
    const nextSignature = JSON.stringify({
      filter,
      selected,
      start,
      width,
      window: window.map((item) => [item.id, item.key, item.label, item.meta]),
    });
    if (signature === nextSignature) return;
    signature = nextSignature;

    filterText.content = new core.StyledText([
      core.bold(core.fg(tokens.accent)("> ")),
      filter.length > 0 ? core.fg(tokens.text)(filter) : core.fg(tokens.muted)("type to filter"),
    ]);
    for (const child of rowsBox.getChildren()) {
      rowsBox.remove(child.id);
      child.destroyRecursively();
    }
    if (visible.length === 0) {
      rowsBox.add(
        new core.TextRenderable(renderer, {
          content: options.empty,
          fg: tokens.muted,
          height: 1,
        }),
      );
      return;
    }
    const inner = width - 6;
    window.forEach((item, index) => {
      const isSelected = start + index === selected;
      const row = new core.BoxRenderable(renderer, {
        id: `${id}-item-${item.id}`,
        height: 1,
        flexDirection: "row",
        backgroundColor: tokens.panel,
        onMouseUp: () => run(item),
      });
      const chunks: ReturnType<typeof core.bold>[] = [
        isSelected ? core.bold(core.fg(tokens.accent)("▎ ")) : core.fg(tokens.panel)("  "),
      ];
      let used = 2;
      if (keyWidth > 0) {
        const key = `[${item.key ?? ""}]`.padEnd(keyWidth + 3);
        chunks.push(core.bold(core.fg(tokens.accent)(key)));
        used += key.length;
      }
      const meta = item.meta !== undefined ? ` · ${item.meta}` : "";
      const label = truncate(item.label, Math.max(4, inner - used - meta.length));
      chunks.push(core.fg(isSelected ? tokens.text : tokens.muted)(label));
      if (meta !== "") chunks.push(core.fg(tokens.muted)(meta));
      row.add(new core.TextRenderable(renderer, { content: new core.StyledText(chunks) }));
      rowsBox.add(row);
    });
  }

  return {
    root,
    isOpen: () => open,
    open: openOverlay,
    close,
    handleKey(key) {
      if (key.ctrl && key.name === "c") return false;
      if (!open) return false;
      if (key.eventType === "release") return true;
      if (key.name === "escape") {
        close();
        return true;
      }
      if (key.name === "return" || key.name === "enter") {
        const item = matches()[selected];
        if (item) run(item);
        return true;
      }
      if (key.name === "up") {
        moveSelection(-1);
        return true;
      }
      if (key.name === "down") {
        moveSelection(1);
        return true;
      }
      if (key.name === "backspace") {
        filter = filter.slice(0, -1);
        selected = 0;
        start = 0;
        layout();
        renderer.requestRender();
        return true;
      }
      const sequence = key.sequence ?? "";
      if (!key.ctrl && key.meta !== true && sequence.length === 1 && sequence >= " ") {
        filter += sequence;
        selected = 0;
        start = 0;
        layout();
        renderer.requestRender();
        return true;
      }
      return true;
    },
    update(next) {
      state = next;
      if (open) layout();
    },
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}
