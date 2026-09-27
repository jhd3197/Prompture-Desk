import { invoke } from "@tauri-apps/api/core";

export interface Project { id: string; name: string; folder: string; model: string; agent: string }
export interface ProjectCatalog {
  models: Array<{ id: string; tools: boolean | null }>;
  agents: Array<{ id: string; name: string; installed: boolean }>;
}
export interface ProjectSession {
  id: string; project: string; model: string; agent: string;
  status: { state: "starting" | "running" | "exited" | "failed" | "closed"; error?: string; exit_code?: number };
}
export const projects = {
  list: () => invoke<Project[]>("list_projects"),
  save: (project: Project) => invoke<Project>("save_project", { project }),
  remove: (id: string) => invoke<void>("remove_project", { id }),
  catalog: () => invoke<ProjectCatalog>("project_catalog"),
  launch: (id: string) => invoke<string>("launch_project", { id }),
  sessions: () => invoke<ProjectSession[]>("project_sessions"),
};
