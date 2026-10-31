import { OOP_ROUTE_PATH } from './copy';

export function oopHref(claimId: string | null): string {
  return claimId ? `${OOP_ROUTE_PATH}?claim_id=${encodeURIComponent(claimId)}` : OOP_ROUTE_PATH;
}
