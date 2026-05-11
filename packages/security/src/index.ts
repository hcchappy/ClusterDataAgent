import { AppError } from "@clusterdata/shared";

export type UserRole = "admin" | "analyst" | "viewer";

export interface AccessRequest {
  readonly role: UserRole;
  readonly tenantId: string;
  readonly resourceTenantId: string;
  readonly action: "read" | "write" | "delete";
}

export function authorizeAccess(request: AccessRequest): {
  readonly allowed: boolean;
  readonly reason?: string;
} {
  if (request.tenantId !== request.resourceTenantId) {
    return {
      allowed: false,
      reason: "Tenant isolation denied access"
    };
  }

  if (request.action !== "read" && request.role === "viewer") {
    return {
      allowed: false,
      reason: "Viewer role is read-only"
    };
  }

  if (request.action === "delete" && request.role !== "admin") {
    return {
      allowed: false,
      reason: "Only admin can delete"
    };
  }

  return { allowed: true };
}

export function assertAccess(request: AccessRequest): void {
  const decision = authorizeAccess(request);

  if (!decision.allowed) {
    throw new AppError(decision.reason ?? "Access denied", "ACCESS_DENIED", 403);
  }
}

