import { z } from "zod";

const httpsUrl = (max: number) => z.string().url().max(max).refine(
  (value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  },
  "must be an absolute HTTPS URL without embedded credentials",
);

export const SignupRequestSchema = z.object({
  email: z.string().email().max(254),
});

export const CreateProjectRequestSchema = z.object({
  name: z.string().min(1).max(100),
  repo_url: httpsUrl(500).optional(),
  default_branch: z.string().max(100).optional(),
  local_path: z.string().max(500).optional(),
});

export const UpdateCaseRequestSchema = z.object({
  agent_summary: z.string().max(8000).optional(),
  pr_url: httpsUrl(500).optional(),
}).strict();

export type SignupRequest = z.infer<typeof SignupRequestSchema>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type UpdateCaseRequest = z.infer<typeof UpdateCaseRequestSchema>;
