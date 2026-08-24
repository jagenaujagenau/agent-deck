import { create } from 'zustand';
import { setChaosSettings } from '@/api/mock-api';

interface SettingsState {
  chaosEnabled: boolean;
  taskUpdateFailureRate: number;
  agentActionFailureRate: number;
  setChaosEnabled: (enabled: boolean) => void;
  setTaskUpdateFailureRate: (rate: number) => void;
  setAgentActionFailureRate: (rate: number) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  chaosEnabled: false,
  taskUpdateFailureRate: 0.1,
  agentActionFailureRate: 0.05,

  setChaosEnabled: (enabled) => {
    set({ chaosEnabled: enabled });
    setChaosSettings(
      enabled,
      useSettingsStore.getState().taskUpdateFailureRate,
      useSettingsStore.getState().agentActionFailureRate,
    );
  },

  setTaskUpdateFailureRate: (rate) => {
    set({ taskUpdateFailureRate: rate });
    setChaosSettings(
      useSettingsStore.getState().chaosEnabled,
      rate,
      useSettingsStore.getState().agentActionFailureRate,
    );
  },

  setAgentActionFailureRate: (rate) => {
    set({ agentActionFailureRate: rate });
    setChaosSettings(
      useSettingsStore.getState().chaosEnabled,
      useSettingsStore.getState().taskUpdateFailureRate,
      rate,
    );
  },
}));
