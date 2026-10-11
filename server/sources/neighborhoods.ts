// Zip to neighbourhood name, for the leads table and the {{neighborhood}} template variable.
// Owned by the sources builder. Spec section 10 lists the seven default zips.

export const NEIGHBORHOODS: Record<string, string> = {
  '19104': 'University City',
  '19121': 'Brewerytown / North Philly',
  '19122': 'Temple area',
  '19139': 'West Philly',
  '19143': 'Southwest Philly',
  '19146': 'Point Breeze / Graduate Hospital',
  '19125': 'Fishtown / Kensington',
  '19123': 'Northern Liberties',
  '19130': 'Fairmount',
  '19131': 'Wynnefield',
  '19132': 'Strawberry Mansion',
  '19133': 'Fairhill',
  '19134': 'Port Richmond / Kensington',
  '19140': 'Hunting Park',
  '19141': 'Logan',
  '19142': 'Southwest Philly',
  '19144': 'Germantown',
  '19145': 'South Philly',
  '19147': 'Queen Village / Bella Vista',
  '19148': 'South Philly',
  '19151': 'Overbrook',
  '19152': 'Rhawnhurst',
  '19153': 'Eastwick',
}

/** Name for one zip, or '' when we have none. */
export function neighborhoodFor(zip: string | null | undefined): string {
  if (!zip) return ''
  return NEIGHBORHOODS[zip.slice(0, 5)] ?? ''
}

/** Name for a lead: first known property zip with a name, else the mailing zip, else ''. */
export function neighborhoodForLead(lead: {
  zips?: string[] | null
  mailing_zip?: string | null
}): string {
  for (const z of lead.zips ?? []) {
    const name = neighborhoodFor(z)
    if (name) return name
  }
  return neighborhoodFor(lead.mailing_zip)
}
