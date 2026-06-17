export const ADMIN_EMAILS: string[] = [
  'dustinstohler1@gmail.com',
  'dustin@otterquote.com',
];

export function isSuperAdminEmail(email?: string | null): boolean {
  return !!email && ADMIN_EMAILS.includes(email);
}
