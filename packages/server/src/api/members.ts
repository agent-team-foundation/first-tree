import { createMemberSchema, updateMemberSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { ForbiddenError } from "../errors.js";
import { requireMember } from "../middleware/require-identity.js";
import * as memberService from "../services/member.js";

function requireAdmin(request: Parameters<typeof requireMember>[0]): void {
  const m = requireMember(request);
  if (m.role !== "admin") {
    throw new ForbiddenError("Only admin can manage members");
  }
}

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    const m = requireMember(request);
    return memberService.listMembers(app.db, m.organizationId);
  });

  app.post("/", async (request, reply) => {
    requireAdmin(request);
    const body = createMemberSchema.parse(request.body);
    const m = requireMember(request);
    const result = await memberService.createMember(app.db, m.organizationId, body);
    return reply.status(201).send(result);
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request) => {
    requireAdmin(request);
    const body = updateMemberSchema.parse(request.body);
    return memberService.updateMember(app.db, request.params.id, body);
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    requireAdmin(request);
    await memberService.deleteMember(app.db, request.params.id);
    return reply.status(204).send();
  });
}
