import { create } from "zustand";
import { persist } from "zustand/middleware";

// Remembers the last Drive folder ID used per project, so the New Run dialog can
// prefill it instead of making the operator retype it. Persisted to localStorage.
type DriveFolderState = {
  // projectId -> last-used Drive folder ID
  folderByProject: Record<number, string>;
  setFolder: (projectId: number, folderId: string) => void;
};

export const useDriveFolderStore = create<DriveFolderState>()(
  persist(
    (set) => ({
      folderByProject: {},
      setFolder: (projectId, folderId) =>
        set((state) => ({
          folderByProject: { ...state.folderByProject, [projectId]: folderId },
        })),
    }),
    { name: "scrapr-drive-folders" },
  ),
);
