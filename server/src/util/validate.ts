import { z, type ZodType } from 'zod';
import { badRequest } from '../errors.js';

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`);
    throw badRequest(issues[0] ?? 'Invalid input', issues);
  }
  return r.data;
}

export function idParam(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Invalid id');
  return n;
}

export const addressSchema = z.union([z.string(), z.object({ name: z.string().nullish(), email: z.string() })]);
export { z };
