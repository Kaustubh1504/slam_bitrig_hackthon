// Request-body validation. Pure, so it can be unit-tested; callers turn errors into 400s.

import type { ParentType, Physics } from "./mashup.ts";

export interface ParentRef {
  type: ParentType;
  id: string;
}

export interface DirectMashupInput {
  parent_a: ParentRef;
  parent_b: ParentRef;
  physics: Physics;
  device_name: string;
}

export interface GenerateArtInput {
  mashup_id: string;
  force: boolean;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_ID_LENGTH = 200;
const MAX_DEVICE_NAME_LENGTH = 100;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validateParent(v: unknown, field: string, errors: string[]): ParentRef | null {
  if (!isRecord(v)) {
    errors.push(`${field} must be an object like {"type": "track", "id": "..."}`);
    return null;
  }
  const { type, id } = v;
  let ok = true;
  if (type !== "track" && type !== "mashup") {
    errors.push(`${field}.type must be "track" or "mashup"`);
    ok = false;
  }
  if (typeof id !== "string" || id.trim() === "" || id.length > MAX_ID_LENGTH) {
    errors.push(`${field}.id must be a non-empty string (max ${MAX_ID_LENGTH} chars)`);
    ok = false;
  } else if (type === "mashup" && !UUID_RE.test(id)) {
    errors.push(`${field}.id must be a UUID when ${field}.type is "mashup"`);
    ok = false;
  }
  return ok ? { type: type as ParentType, id: (id as string).trim() } : null;
}

function validatePhysics(v: unknown, errors: string[]): Physics | null {
  if (!isRecord(v)) {
    errors.push("physics must be an object with velocity_deg_s, tilt, contact_angle, and optional hold_ms");
    return null;
  }
  const { velocity_deg_s, tilt, contact_angle, hold_ms } = v;
  const before = errors.length;
  if (!isFiniteNumber(velocity_deg_s) || velocity_deg_s < 0) {
    errors.push("physics.velocity_deg_s must be a number >= 0");
  }
  if (!isFiniteNumber(tilt)) errors.push("physics.tilt must be a number");
  if (!isFiniteNumber(contact_angle)) errors.push("physics.contact_angle must be a number");
  const hasHold = hold_ms !== undefined && hold_ms !== null;
  if (hasHold && (!isFiniteNumber(hold_ms) || hold_ms < 0)) {
    errors.push("physics.hold_ms must be a number >= 0 when provided");
  }
  if (errors.length > before) return null;

  // Rebuild rather than pass through so unknown keys never reach the database.
  const physics: Physics = {
    velocity_deg_s: velocity_deg_s as number,
    tilt: tilt as number,
    contact_angle: contact_angle as number,
  };
  if (hasHold) physics.hold_ms = hold_ms as number;
  return physics;
}

export function validateDirectMashupInput(body: unknown): Validation<DirectMashupInput> {
  if (!isRecord(body)) return { ok: false, errors: ["Body must be a JSON object"] };

  const errors: string[] = [];
  const parent_a = validateParent(body.parent_a, "parent_a", errors);
  const parent_b = validateParent(body.parent_b, "parent_b", errors);
  const physics = validatePhysics(body.physics, errors);

  const { device_name } = body;
  if (
    typeof device_name !== "string" || device_name.trim() === "" ||
    device_name.length > MAX_DEVICE_NAME_LENGTH
  ) {
    errors.push(`device_name must be a non-empty string (max ${MAX_DEVICE_NAME_LENGTH} chars)`);
  }

  if (parent_a && parent_b && parent_a.type === parent_b.type && parent_a.id === parent_b.id) {
    errors.push("parent_a and parent_b must be different");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      parent_a: parent_a!,
      parent_b: parent_b!,
      physics: physics!,
      device_name: (device_name as string).trim(),
    },
  };
}

export function validateGenerateArtInput(body: unknown): Validation<GenerateArtInput> {
  if (!isRecord(body)) return { ok: false, errors: ["Body must be a JSON object"] };

  const errors: string[] = [];
  const { mashup_id, force } = body;
  if (typeof mashup_id !== "string" || !UUID_RE.test(mashup_id)) {
    errors.push("mashup_id must be a UUID");
  }
  if (force !== undefined && typeof force !== "boolean") {
    errors.push("force must be a boolean when provided");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { mashup_id: mashup_id as string, force: force === true } };
}
