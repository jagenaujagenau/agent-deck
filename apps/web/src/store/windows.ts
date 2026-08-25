import { create } from "zustand";

export interface WindowPosition {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
}

interface WindowsState {
  windows: Record<string, WindowPosition>; // agentId -> position
  maxZIndex: number;
  openWindow: (agentId: string, position?: Partial<WindowPosition>) => void;
  closeWindow: (agentId: string) => void;
  updateWindowPosition: (agentId: string, position: Partial<WindowPosition>) => void;
  focusWindow: (agentId: string) => void;
  minimizeWindow: (agentId: string) => void;
  restoreWindow: (agentId: string) => void;
  getWindowZIndex: (agentId: string) => number;
}

const DEFAULT_WINDOW_SIZE = {
  width: 500,
  height: 600,
};

export const useWindowsStore = create<WindowsState>((set, get) => ({
  windows: {},
  maxZIndex: 1000,

  openWindow: (agentId, position) => {
    const existing = get().windows[agentId];
    if (existing) {
      get().focusWindow(agentId);
      return;
    }

    const newZIndex = get().maxZIndex + 1;
    set({
      windows: {
        ...get().windows,
        [agentId]: {
          x: position?.x ?? window.innerWidth / 2 - DEFAULT_WINDOW_SIZE.width / 2,
          y: position?.y ?? window.innerHeight / 2 - DEFAULT_WINDOW_SIZE.height / 2,
          width: position?.width ?? DEFAULT_WINDOW_SIZE.width,
          height: position?.height ?? DEFAULT_WINDOW_SIZE.height,
          zIndex: newZIndex,
          minimized: false,
        },
      },
      maxZIndex: newZIndex,
    });
  },

  closeWindow: (agentId) => {
    const { [agentId]: _, ...rest } = get().windows;
    set({ windows: rest });
  },

  updateWindowPosition: (agentId, position) => {
    const window = get().windows[agentId];
    if (!window) return;

    set({
      windows: {
        ...get().windows,
        [agentId]: {
          ...window,
          ...position,
        },
      },
    });
  },

  focusWindow: (agentId) => {
    const window = get().windows[agentId];
    if (!window) return;

    const newZIndex = get().maxZIndex + 1;
    set({
      windows: {
        ...get().windows,
        [agentId]: {
          ...window,
          zIndex: newZIndex,
        },
      },
      maxZIndex: newZIndex,
    });
  },

  minimizeWindow: (agentId) => {
    get().updateWindowPosition(agentId, { minimized: true });
  },

  restoreWindow: (agentId) => {
    get().updateWindowPosition(agentId, { minimized: false });
  },

  getWindowZIndex: (agentId) => {
    return get().windows[agentId]?.zIndex ?? 0;
  },
}));
