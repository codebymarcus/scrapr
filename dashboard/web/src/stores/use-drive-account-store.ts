import { create } from "zustand";
import { persist } from "zustand/middleware";

// Remembers the last Drive account used per project, so the New Run dialog can
// preselect it instead of making the operator pick it again. Persisted to
// localStorage.
type DriveAccountState = {
  // projectId -> last-used Drive account ID
  accountByProject: Record<number, string>;
  setAccount: (projectId: number, accountId: string) => void;
};

export const useDriveAccountStore = create<DriveAccountState>()(
  persist(
    (set) => ({
      accountByProject: {},
      setAccount: (projectId, accountId) =>
        set((state) => ({
          accountByProject: {
            ...state.accountByProject,
            [projectId]: accountId,
          },
        })),
    }),
    { name: "scrapr-drive-accounts" },
  ),
);
