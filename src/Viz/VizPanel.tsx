import { type Component, type JSX, Show, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import type { PanelState } from './vizStore';
import { vizStore } from './vizStore';

/**
 * Panels store a compact stacking rank (1..N); the rendered z-index adds this
 * base so they always float above app content while staying bounded.
 */
const Z_INDEX_BASE = 10000;

// Matches the close button's style; disabled just dims + drops the pointer.
function headerBtnStyle(disabled: boolean) {
  return {
    background: 'var(--viz-button-bg, #555)',
    border: '1px solid var(--viz-button-border, transparent)',
    color: 'var(--viz-button-fg, white)',
    padding: '2px 8px',
    'border-radius': 'var(--viz-radius-sm, 4px)',
    cursor: disabled ? 'default' : 'pointer',
    'font-size': '14px',
    'line-height': '1',
    opacity: disabled ? '0.4' : '1',
  } as const;
}

// A small stroked chevron used as the "more to scroll" hint.
const ChevronIcon: Component<{ dir: 'up' | 'down' }> = (props) => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="3.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <polyline points={props.dir === 'up' ? '5 15 12 8 19 15' : '5 9 12 16 19 9'} />
  </svg>
);

// Centered chevron pinned to the top/bottom edge of the scroll area. A bg
// drop-shadow keeps it legible over busy content without needing a chip.
function scrollHintStyle(edge: 'top' | 'bottom'): JSX.CSSProperties {
  return {
    position: 'absolute',
    [edge]: '3px',
    left: '0',
    right: '0',
    display: 'flex',
    'justify-content': 'center',
    'pointer-events': 'none',
    color: 'var(--viz-fg, #fff)',
    filter: 'drop-shadow(0 0 2px var(--viz-bg, rgba(0, 0, 0, 0.9)))',
  };
}

export interface VizPanelProps {
  panel: PanelState;
}

export const VizPanel: Component<VizPanelProps> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  let headerRef: HTMLDivElement | undefined;
  let contentRef: HTMLDivElement | undefined;
  let innerRef: HTMLDivElement | undefined;

  // Small chevrons signal clipped overflow in lieu of a scrollbar.
  const [canScrollUp, setCanScrollUp] = createSignal(false);
  const [canScrollDown, setCanScrollDown] = createSignal(false);
  // Hover state for the docked vertical-resize handle (drives its highlight).
  const [handleHover, setHandleHover] = createSignal(false);

  const [isDragging, setIsDragging] = createSignal(false);
  const [isResizing, setIsResizing] = createSignal(false);
  const [dragOffset, setDragOffset] = createSignal({ x: 0, y: 0 });
  const [resizeStart, setResizeStart] = createSignal({ x: 0, y: 0, width: 0, height: 0 });
  // Measured header height — the collapsed panel shrinks to exactly this so the
  // height transition animates to a real pixel value (not `auto`).
  const [headerH, setHeaderH] = createSignal(37);

  // Convert negative positions (from right/bottom edge) to absolute pixels
  const getAbsolutePosition = () => {
    const panel = props.panel;
    let left = panel.x;
    let top = panel.y;

    if (panel.x < 0) {
      left = window.innerWidth - panel.width + panel.x;
    }
    if (panel.y < 0) {
      top = window.innerHeight - panel.height + panel.y;
    }

    return { left, top };
  };

  const [position, setPosition] = createSignal(getAbsolutePosition());
  const [viewportH, setViewportH] = createSignal(
    typeof window !== 'undefined' ? window.innerHeight : 800
  );

  // Re-sync the rendered position whenever the store's x/y change
  // programmatically (e.g. arrangePanels) — but never override an in-progress
  // drag/resize. getAbsolutePosition reads panel.x/y/width/height, so this
  // effect tracks them.
  createEffect(() => {
    const next = getAbsolutePosition();
    if (!isDragging() && !isResizing()) {
      setPosition(next);
    }
  });

  // Screen-conforming height: cap the panel so it never runs off the bottom
  // of the viewport; the body scrolls inside the cap. Collapsed = header only.
  const maxBodyHeight = () =>
    Math.max(120, viewportH() - position().top - 10);

  // Rendered height in px — collapsed shrinks to the header so the CSS height
  // transition animates between two real values.
  const effectiveHeight = () =>
    props.panel.collapsed
      ? headerH()
      : Math.min(props.panel.height, maxBodyHeight());

  const updateScrollHints = () => {
    const el = contentRef;
    if (!el) return;
    setCanScrollUp(el.scrollTop > 1);
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  };

  // Measure the natural (unclipped) content height and report it so the dock
  // layout can size this panel to its content. The inner wrapper's height is
  // intrinsic to the content (independent of the panel's clipped height), so
  // observing it can't feed back into a resize loop.
  const reportNatural = () => {
    if (headerRef && innerRef) {
      vizStore.reportNaturalHeight(
        props.panel.id,
        headerRef.offsetHeight + innerRef.offsetHeight
      );
    }
    updateScrollHints();
  };

  onMount(() => {
    if (headerRef) setHeaderH(headerRef.offsetHeight);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => reportNatural());
      if (innerRef) ro.observe(innerRef); // content grew/shrank
      if (contentRef) ro.observe(contentRef); // clip height changed → re-fade
    }
    reportNatural();
    onCleanup(() => ro?.disconnect());
  });

  // A panel has undoable settings once any control seeds/writes its `data`
  // (or once it has history). Panels that never touch settings (EventBus,
  // Entities) stay empty, so the undo/redo buttons don't appear for them.
  const hasUndoableSettings = () =>
    Object.keys(props.panel.data ?? {}).length > 0 ||
    props.panel.history.past.length > 0 ||
    props.panel.history.future.length > 0;

  onMount(() => {
    // Recalculate position + viewport cap on window resize
    const handleResize = () => {
      setViewportH(window.innerHeight);
      if (!isDragging() && !isResizing()) {
        setPosition(getAbsolutePosition());
      }
    };
    window.addEventListener('resize', handleResize);
    onCleanup(() => window.removeEventListener('resize', handleResize));
  });

  let dragStartClientX = 0;
  // How far the title must be dragged toward the center to break a docked
  // panel back out to free-floating.
  const DOCK_BREAK_PX = 40;

  const onHeaderMouseDown = (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;

    setIsDragging(true);
    dragStartClientX = e.clientX;
    const pos = position();
    setDragOffset({
      x: e.clientX - pos.left,
      y: e.clientY - pos.top,
    });
    e.preventDefault();
  };

  const onResizeMouseDown = (e: MouseEvent) => {
    setIsResizing(true);
    setResizeStart({
      x: e.clientX,
      y: e.clientY,
      width: props.panel.width,
      height: props.panel.height,
    });
    e.preventDefault();
    e.stopPropagation();
  };

  // Docked panels resize height only (width = the dock column); the move
  // handler branches on `dock` and commits a viewport ratio.
  const onDockResizeMouseDown = (e: MouseEvent) => {
    setIsResizing(true);
    e.preventDefault();
    e.stopPropagation();
  };

  onMount(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging()) {
        // A docked panel doesn't move until the title is dragged toward the
        // center past the break threshold — then it pops out to free-floating
        // and the normal drag takes over from the cursor.
        if (props.panel.dock) {
          const toward =
            props.panel.dock === 'left'
              ? e.clientX - dragStartClientX
              : dragStartClientX - e.clientX;
          if (toward > DOCK_BREAK_PX) {
            const offset = dragOffset();
            vizStore.undockPanel(
              props.panel.id,
              Math.max(0, e.clientX - offset.x),
              Math.max(0, e.clientY - offset.y)
            );
          }
          return;
        }
        const offset = dragOffset();
        const newX = Math.max(0, Math.min(e.clientX - offset.x, window.innerWidth - props.panel.width));
        const newY = Math.max(0, Math.min(e.clientY - offset.y, window.innerHeight - props.panel.height));
        setPosition({ left: newX, top: newY });
      }

      if (isResizing()) {
        if (props.panel.dock) {
          // Docked: vertical-only. Commit as a viewport ratio so the column
          // reflows around it and the height survives reloads/resizes.
          const newHeight = Math.max(80, e.clientY - position().top);
          vizStore.setDockHeightRatio(props.panel.id, newHeight / viewportH());
        } else {
          const start = resizeStart();
          const deltaX = e.clientX - start.x;
          const deltaY = e.clientY - start.y;
          const newWidth = Math.max(200, start.width + deltaX);
          const newHeight = Math.max(100, start.height + deltaY);
          vizStore.updateSize(props.panel.id, newWidth, newHeight);
        }
      }
    };

    const handleMouseUp = () => {
      if (isDragging()) {
        // Docked panels are positioned by the dock layout — don't persist the
        // drag (a click that didn't break out leaves it docked).
        if (!props.panel.dock) {
          const pos = position();
          vizStore.updatePosition(props.panel.id, pos.left, pos.top);
        }
        setIsDragging(false);
      }
      if (isResizing()) {
        setIsResizing(false);
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    onCleanup(() => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    });
  });

  return (
    <div
      ref={containerRef}
      class="viz-panel"
      onMouseDown={() => vizStore.raisePanel(props.panel.id)}
      style={{
        position: 'fixed',
        left: `${position().left}px`,
        top: `${position().top}px`,
        width: `${props.panel.width}px`,
        height: `${effectiveHeight()}px`,
        background: 'var(--viz-bg, rgba(0, 0, 0, 0.9))',
        color: 'var(--viz-fg, #fff)',
        'font-family': 'var(--viz-font, monospace)',
        'font-size': 'var(--viz-font-size, 11px)',
        'border-radius': 'var(--viz-radius, 8px)',
        overflow: 'hidden',
        'z-index': `${Z_INDEX_BASE + props.panel.z}`,
        'box-shadow': '0 4px 20px rgba(0, 0, 0, 0.5)',
        display: 'flex',
        'flex-direction': 'column',
        // Free panels keep a sane floor; docked panels follow the dock column
        // width (clamped to 160 in setDockWidth) so the resize handle stays
        // glued to the panel edge instead of overshooting behind it.
        'min-width': props.panel.dock ? '0' : '200px',
        'min-height': '0',
        // Animate collapse + dock-column reflow; immediate while dragging/resizing.
        transition:
          isDragging() || isResizing()
            ? 'none'
            : 'height 180ms ease, top 180ms ease, left 180ms ease, width 180ms ease',
      }}
    >
      {/* Header */}
      <div
        ref={headerRef}
        class="viz-header"
        onMouseDown={onHeaderMouseDown}
        style={{
          padding: '8px 12px',
          background: 'var(--viz-header-bg, #333)',
          color: 'var(--viz-header-fg, #fff)',
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          gap: '8px',
          'flex-shrink': '0',
          'border-bottom': '1px solid var(--viz-border, #444)',
          cursor: 'move',
          'user-select': 'none',
        }}
      >
        <div
          style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'min-width': '0' }}
        >
          <button
            class="viz-collapse"
            title={props.panel.collapsed ? 'Expand' : 'Collapse'}
            aria-label={props.panel.collapsed ? 'Expand panel' : 'Collapse panel'}
            onClick={() => vizStore.toggleCollapsed(props.panel.id)}
            style={{ ...headerBtnStyle(false), 'flex-shrink': '0' }}
          >
            {props.panel.collapsed ? '▸' : '▾'}
          </button>
          <span
            style={{
              'font-weight': 'bold',
              // Theme's header-title wins when a theme is loaded; the per-panel
              // titleColor is only the fallback for apps with no viz theme CSS.
              color: `var(--viz-header-title, ${props.panel.titleColor || '#66ccff'})`,
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
            }}
          >
            {props.panel.title}
          </span>
        </div>

        {/* Optional compact summary, shown only in the collapsed title bar. */}
        <Show when={props.panel.collapsed && props.panel.headerSummary}>
          <div
            class="viz-header__summary"
            style={{ flex: '1', 'min-width': '0', overflow: 'hidden', 'text-align': 'right' }}
          >
            {props.panel.headerSummary!()}
          </div>
        </Show>

        <div style={{ display: 'flex', 'align-items': 'center', gap: '4px', 'flex-shrink': '0' }}>
          {/* Undo/redo only for panels with undoable settings — a panel that
              never writes any setting (e.g. EventBus) shows nothing. */}
          <Show when={hasUndoableSettings()}>
            <button
              class="viz-undo"
              title="Undo panel setting"
              aria-label="Undo panel setting"
              disabled={props.panel.history.past.length === 0}
              onClick={() => vizStore.undo(props.panel.id)}
              style={headerBtnStyle(props.panel.history.past.length === 0)}
            >
              ↶
            </button>
            <button
              class="viz-redo"
              title="Redo panel setting"
              aria-label="Redo panel setting"
              disabled={props.panel.history.future.length === 0}
              onClick={() => vizStore.redo(props.panel.id)}
              style={headerBtnStyle(props.panel.history.future.length === 0)}
            >
              ↷
            </button>
          </Show>
          <button
            onClick={() => vizStore.hidePanel(props.panel.id)}
            style={{
              background: 'var(--viz-button-bg, #555)',
              border: '1px solid var(--viz-button-border, transparent)',
              color: 'var(--viz-button-fg, white)',
              padding: '2px 8px',
              'border-radius': 'var(--viz-radius-sm, 4px)',
              cursor: 'pointer',
              'font-size': '14px',
              'line-height': '1',
            }}
          >
            &times;
          </button>
        </div>
      </div>

      {/* Body — always rendered so collapse can animate the container height;
          the container's overflow:hidden clips it while collapsed. The scroll
          container hides its scrollbar; edge fades hint at clipped overflow. */}
      <div
        style={{
          position: 'relative',
          flex: '1',
          'min-height': '0',
          display: 'flex',
          'flex-direction': 'column',
        }}
      >
        <div
          ref={contentRef}
          class="viz-content"
          onScroll={updateScrollHints}
          style={{
            flex: '1',
            'min-height': '0',
            'overflow-y': 'auto',
            'overflow-x': 'hidden',
            // No scrollbar — overflow is signalled by the edge fades below.
            'scrollbar-width': 'none',
          }}
        >
          <div
            ref={innerRef}
            style={{
              padding: '10px 12px',
              display: 'flex',
              'flex-direction': 'column',
            }}
          >
            {props.panel.content()}
          </div>
        </div>
        {/* Small contrasty chevrons hint at clipped overflow (no scrollbar).
            Hidden while collapsed — there's no scrollable body then. */}
        <Show when={canScrollUp() && !props.panel.collapsed}>
          <div style={scrollHintStyle('top')}>
            <ChevronIcon dir="up" />
          </div>
        </Show>
        <Show when={canScrollDown() && !props.panel.collapsed}>
          <div style={scrollHintStyle('bottom')}>
            <ChevronIcon dir="down" />
          </div>
        </Show>
      </div>

      {/* Free-floating: corner handle resizes width + height. */}
      <Show when={!props.panel.collapsed && !props.panel.dock}>
        <div
          class="viz-resize-handle"
          onMouseDown={onResizeMouseDown}
          style={{
            position: 'absolute',
            bottom: '0',
            right: '0',
            width: '16px',
            height: '16px',
            cursor: 'se-resize',
            background: 'linear-gradient(135deg, transparent 50%, var(--viz-border, #555) 50%)',
            'border-radius': '0 0 var(--viz-radius, 8px) 0',
          }}
        />
      </Show>

      {/* Docked: bottom-edge handle sets a manual height (saved as a viewport
          ratio); double-click resets the panel to content-aware auto-fit. A
          faint grip is always visible (so the handle is discoverable) and pops
          to an accent bar on hover/drag — mirroring the dock-column resizers. */}
      <Show when={!props.panel.collapsed && props.panel.dock}>
        <div
          class="viz-resize-handle viz-resize-handle--bottom"
          onMouseDown={onDockResizeMouseDown}
          onDblClick={() => vizStore.clearDockHeightRatio(props.panel.id)}
          onMouseEnter={() => setHandleHover(true)}
          onMouseLeave={() => setHandleHover(false)}
          title="Drag to set height · double-click to auto-fit"
          style={{
            position: 'absolute',
            bottom: '0',
            left: '0',
            right: '0',
            height: handleHover() || isResizing() ? '12px' : '7px',
            cursor: 'ns-resize',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            background:
              handleHover() || isResizing() ? 'var(--viz-accent, #66ccff)' : 'transparent',
            'border-radius': '0 0 var(--viz-radius, 8px) var(--viz-radius, 8px)',
            transition: 'height 120ms ease, background 120ms ease',
          }}
        >
          {/* Grip pill: faint by default, reads as a notch on the accent bar. */}
          <div
            style={{
              'pointer-events': 'none',
              width: '32px',
              height: '3px',
              'border-radius': '2px',
              background:
                handleHover() || isResizing()
                  ? 'var(--viz-bg, rgba(0, 0, 0, 0.9))'
                  : 'var(--viz-border, #555)',
            }}
          />
        </div>
      </Show>
    </div>
  );
};
