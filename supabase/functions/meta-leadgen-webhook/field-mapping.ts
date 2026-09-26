// gh-2154 P-5 — maps a Meta lead's field_data (Graph API GET /{leadgen_id})
// to the fields register_partner() needs. field_data is an array of
// { name, values: string[] } pairs (Meta's Marketing API "Lead Ads Webhooks"
// / "Retrieving Leads" docs — cited in this build's report); the exact
// field names depend on the form's configured questions, so this accepts
// the common synonyms Meta's own form builder offers.

export interface LeadFieldDatum {
  name: string;
  values?: string[];
}

export interface MappedLeadFields {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
}

function firstValue(fieldData: LeadFieldDatum[], names: string[]): string | null {
  for (const f of fieldData) {
    if (!f || typeof f.name !== "string") continue;
    if (!names.includes(f.name.toLowerCase())) continue;
    if (!Array.isArray(f.values) || f.values.length === 0) continue;
    const v = String(f.values[0]).trim();
    if (v) return v;
  }
  return null;
}

export function mapFieldData(fieldData: LeadFieldDatum[] | null | undefined): MappedLeadFields {
  const fd = Array.isArray(fieldData) ? fieldData : [];

  const fullNameRaw = firstValue(fd, ["full_name", "name"]);
  let firstName = firstValue(fd, ["first_name"]);
  let lastName = firstValue(fd, ["last_name"]);

  if (!firstName && !lastName && fullNameRaw) {
    const parts = fullNameRaw.split(/\s+/).filter(Boolean);
    firstName = parts[0] ?? null;
    lastName = parts.slice(1).join(" ") || null;
  }

  const fullName = fullNameRaw ?? ([firstName, lastName].filter(Boolean).join(" ") || null);

  return {
    firstName,
    lastName,
    fullName,
    email: firstValue(fd, ["email"]),
    phone: firstValue(fd, ["phone_number", "phone"]),
    company: firstValue(fd, ["company_name", "company"]),
  };
}
