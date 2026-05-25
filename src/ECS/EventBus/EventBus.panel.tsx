import { Component, For, Show, type Accessor, type Setter } from 'solid-js';

// ============================================
// Types
// ============================================

export interface EventEntry {
  timestamp: number;
  lastTimestamp: number;
  event: string;
  data: any;
  entityId: string;
}

export interface EntityGroup {
  entityId: string;
  events: Map<string, EventEntry>;
  lastEventTime: number;
}

export interface EventBusDebuggerPanelProps {
  filter: Accessor<string>;
  setFilter: Setter<string>;
  paused: Accessor<boolean>;
  togglePause: () => void;
  clear: () => void;
  entityGroups: Accessor<Map<string, EntityGroup>>;
  expandedEntities: Accessor<Set<string>>;
  toggleEntity: (entityId: string) => void;
  expandedEvents: Accessor<Set<string>>;
  toggleEvent: (entityId: string, eventType: string) => void;
  flashingEntities: Accessor<Set<string>>;
  flashingEvents: Accessor<Set<string>>;
}

// ============================================
// Event color helper
// ============================================

function getEventColor(event: string): string {
  if (event.startsWith("keyboard")) return "#4a9eff";
  if (event.startsWith("playerinput")) return "#4aff4a";
  if (event.startsWith("movement") || event.startsWith("input.movement") || event.startsWith("input.jump")) return "#ff9f4a";
  if (event.startsWith("mesh")) return "#ff4a9e";
  if (event.startsWith("arccamera")) return "#9e4aff";
  if (event.startsWith("bouncy")) return "#ff4a4a";
  if (event.startsWith("obstacle")) return "#4affff";
  if (event.startsWith("shadow")) return "#ffff4a";
  if (event.startsWith("ai.")) return "#ff66ff";
  if (event.startsWith("goal.")) return "#00ff88";
  if (event.startsWith("score.")) return "#ffcc00";
  if (event.startsWith("physics.")) return "#ff8844";
  if (event.startsWith("world.")) return "#8888ff";
  if (event.startsWith("entity.")) return "#88ffff";
  if (event.startsWith("teamspawner.")) return "#ff88ff";
  return "#888";
}

// ============================================
// Data formatting helper
// ============================================

function formatEventData(data: any): string {
  if (data === null || data === undefined) {
    return "";
  }

  if (typeof data !== "object") {
    return String(data);
  }

  const entries = Object.entries(data);
  if (entries.length === 0) {
    return "";
  }

  const parts: string[] = [];
  for (const [key, value] of entries) {
    if (key === "entityId" || key === "entity") continue;

    let valueStr: string;
    if (typeof value === "number") {
      const fixed = (value as number).toFixed(1);
      valueStr = value >= 0 ? ` ${fixed}` : fixed;
    } else if (typeof value === "boolean") {
      valueStr = String(value);
    } else if (typeof value === "string") {
      valueStr = value.length > 30 ? value.slice(0, 30) + "..." : value;
    } else if (value === null) {
      valueStr = "null";
    } else if (Array.isArray(value)) {
      valueStr = `[${value.length}]`;
    } else if (typeof value === "object") {
      const keys = Object.keys(value);
      valueStr = keys.length <= 3 ? `{${keys.join(", ")}}` : `{${keys.length} keys}`;
    } else {
      valueStr = String(value);
    }
    parts.push(`${key}: ${valueStr}`);
  }
  return parts.join("  ");
}

// ============================================
// Event Row Component
// ============================================

interface EventRowProps {
  entry: EventEntry;
  entityId: string;
  isExpanded: boolean;
  isFlashing: boolean;
  onToggle: () => void;
}

const EventRow: Component<EventRowProps> = (props) => {
  const color = getEventColor(props.entry.event);
  // Only data-bearing events are expandable; otherwise there's nothing to show
  // so we drop the caret (and the click affordance).
  const detail = () => formatEventData(props.entry.data);
  const hasDetail = () => detail().length > 0;

  return (
    <div
      style={{
        "margin-bottom": "4px",
        padding: "4px 8px",
        // Faint wash of the event color over the theme's inset surface, so the
        // event keeps a color identity without tinting the text. Falls back to
        // the plain inset bg where color-mix isn't supported.
        background: "var(--viz-bg-inset, #222)",
        "background-image": `linear-gradient(color-mix(in srgb, ${color} 12%, transparent), color-mix(in srgb, ${color} 12%, transparent))`,
        "border-radius": "var(--viz-radius-sm, 4px)",
        "border-left": `3px solid ${color}`,
      }}
    >
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "6px",
          cursor: hasDetail() ? "pointer" : "default",
          "user-select": "none",
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (hasDetail()) props.onToggle();
        }}
      >
        <span style={{ color: "var(--viz-fg-muted, #666)", "font-size": "10px", width: "10px" }}>
          <Show when={hasDetail()}>{props.isExpanded ? "▼" : "▶"}</Show>
        </span>
        <span style={{ color: "var(--viz-fg, #ddd)", "font-size": "11px", flex: "1" }}>
          {props.entry.event}
        </span>
        <span
          style={{
            color,
            "font-size": "10px",
            opacity: props.isFlashing ? "1" : "0",
            transition: "opacity 0.1s",
          }}
        >
          ⚡
        </span>
      </div>
      <Show when={props.isExpanded && hasDetail()}>
        <div
          style={{
            "font-size": "10px",
            "margin-top": "6px",
            "padding-left": "16px",
            "line-height": "1.5",
            color: "var(--viz-fg-soft, #aaa)",
          }}
        >
          {detail()}
        </div>
      </Show>
    </div>
  );
};

// ============================================
// Entity Group Component
// ============================================

interface EntityGroupComponentProps {
  entityId: string;
  group: EntityGroup;
  filter: string;
  isExpanded: boolean;
  isFlashing: boolean;
  expandedEvents: Set<string>;
  flashingEvents: Set<string>;
  onToggleEntity: () => void;
  onToggleEvent: (eventType: string) => void;
}

const EntityGroupComponent: Component<EntityGroupComponentProps> = (props) => {
  const filteredEvents = () => {
    const events = [...props.group.events.values()];
    if (!props.filter) return events;
    return events.filter(e =>
      e.event.toLowerCase().includes(props.filter) ||
      props.entityId.toLowerCase().includes(props.filter)
    );
  };

  const sortedEvents = () => {
    return filteredEvents().sort((a, b) => a.event.localeCompare(b.event));
  };

  return (
    <div style={{ "margin-bottom": "8px" }}>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "6px",
          padding: "6px 8px",
          background: "var(--viz-header-bg, #333)",
          color: "var(--viz-header-fg, #fff)",
          "border-radius": "var(--viz-radius-sm, 4px)",
          cursor: "pointer",
          "user-select": "none",
        }}
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleEntity();
        }}
      >
        <span style={{ color: "var(--viz-header-fg, #888)", "font-size": "10px", width: "10px" }}>
          {props.isExpanded ? "▼" : "▶"}
        </span>
        <span style={{ color: "var(--viz-header-fg, #fff)", "font-weight": "bold", "font-size": "12px", flex: "1" }}>
          {props.entityId}
        </span>
        <span
          style={{
            color: "var(--viz-accent, #ffcc00)",
            "font-size": "12px",
            opacity: props.isFlashing ? "1" : "0",
            transition: "opacity 0.1s",
          }}
        >
          ⚡
        </span>
      </div>
      <Show when={props.isExpanded}>
        <div
          style={{
            "padding-left": "12px",
            "margin-top": "4px",
            display: "flex",
            "flex-direction": "column",
          }}
        >
          <For each={sortedEvents()}>
            {(entry) => (
              <EventRow
                entry={entry}
                entityId={props.entityId}
                isExpanded={props.expandedEvents.has(`${props.entityId}:${entry.event}`)}
                isFlashing={props.flashingEvents.has(`${props.entityId}:${entry.event}`)}
                onToggle={() => props.onToggleEvent(entry.event)}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

// ============================================
// Main Panel Component
// ============================================

export const EventBusDebuggerPanel: Component<EventBusDebuggerPanelProps> = (props) => {
  const totalEvents = () => {
    let count = 0;
    for (const group of props.entityGroups().values()) {
      count += group.events.size;
    }
    return count;
  };

  const sortedEntityIds = () => {
    const now = performance.now();
    const ACTIVE_THRESHOLD_MS = 2000;
    return [...props.entityGroups().entries()]
      .sort((a, b) => {
        const aActive = (now - a[1].lastEventTime) < ACTIVE_THRESHOLD_MS;
        const bActive = (now - b[1].lastEventTime) < ACTIVE_THRESHOLD_MS;
        if (aActive !== bActive) {
          return aActive ? -1 : 1;
        }
        return a[0].localeCompare(b[0]);
      })
      .map(([entityId]) => entityId);
  };

  const visibleEntityIds = () => {
    return sortedEntityIds().filter(entityId => {
      const group = props.entityGroups().get(entityId);
      if (!group) return false;
      if (!props.filter()) return true;
      return [...group.events.values()].some(e =>
        e.event.toLowerCase().includes(props.filter()) ||
        entityId.toLowerCase().includes(props.filter())
      );
    });
  };

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "min-height": "0",
      }}
    >
      {/* Controls */}
      <div
        style={{
          display: "flex",
          gap: "6px",
          "margin-bottom": "8px",
          "flex-shrink": "0",
        }}
      >
        <button
          style={{
            background: "var(--viz-button-bg, #555)",
            border: "1px solid var(--viz-button-border, transparent)",
            color: "var(--viz-button-fg, white)",
            padding: "4px 8px",
            "border-radius": "var(--viz-radius-sm, 4px)",
            cursor: "pointer",
            "font-family": "var(--viz-font, monospace)",
          }}
          onClick={(e) => {
            e.stopPropagation();
            props.togglePause();
          }}
        >
          {props.paused() ? "▶" : "⏸"}
        </button>
        <button
          style={{
            background: "var(--viz-button-bg, #555)",
            border: "1px solid var(--viz-button-border, transparent)",
            color: "var(--viz-button-fg, white)",
            padding: "4px 8px",
            "border-radius": "var(--viz-radius-sm, 4px)",
            cursor: "pointer",
            "font-family": "var(--viz-font, monospace)",
          }}
          onClick={(e) => {
            e.stopPropagation();
            props.clear();
          }}
        >
          Clear
        </button>
        <span
          style={{
            color: "var(--viz-fg-muted, #666)",
            "font-size": "10px",
            "margin-left": "auto",
            "align-self": "center",
          }}
        >
          {props.entityGroups().size} entities, {totalEvents()} events
        </span>
      </div>

      {/* Filter */}
      <div style={{ "margin-bottom": "8px", "flex-shrink": "0" }}>
        <input
          type="text"
          placeholder="Filter events..."
          value={props.filter()}
          onInput={(e) => props.setFilter(e.currentTarget.value.toLowerCase())}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            padding: "6px 8px",
            background: "var(--viz-input-bg, #222)",
            border: "1px solid var(--viz-input-border, #444)",
            color: "var(--viz-input-fg, #fff)",
            "border-radius": "var(--viz-radius-sm, 4px)",
            "font-family": "var(--viz-font, monospace)",
            "font-size": "11px",
            "box-sizing": "border-box",
          }}
        />
      </div>

      {/* Event list */}
      <div
        style={{
          flex: "1",
          "overflow-y": "auto",
          "min-height": "0",
          display: "flex",
          "flex-direction": "column",
        }}
      >
        <Show
          when={visibleEntityIds().length > 0}
          fallback={
            <div style={{ color: "var(--viz-fg-muted, #666)", "text-align": "center", padding: "20px" }}>
              No events{props.filter() ? ` matching "${props.filter()}"` : ""}
            </div>
          }
        >
          <For each={visibleEntityIds()}>
            {(entityId) => {
              const group = () => props.entityGroups().get(entityId);
              return (
                <Show when={group()}>
                  {(g) => (
                    <EntityGroupComponent
                      entityId={entityId}
                      group={g()}
                      filter={props.filter()}
                      isExpanded={props.expandedEntities().has(entityId)}
                      isFlashing={props.flashingEntities().has(entityId)}
                      expandedEvents={props.expandedEvents()}
                      flashingEvents={props.flashingEvents()}
                      onToggleEntity={() => props.toggleEntity(entityId)}
                      onToggleEvent={(eventType) => props.toggleEvent(entityId, eventType)}
                    />
                  )}
                </Show>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
};
