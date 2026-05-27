// RAOB (upper-air sounding) station catalog for the Mid-South AOR + a few
// surrounding stations for system-tracking. Each entry knows its station IDs
// in the major sounding services so the SoundingPanel can build correct
// external links per service.
//
// Why external links instead of an iframe:
//   - SPC's interactive sounding viewer is JS-heavy and not iframe-friendly
//     (returns empty/blank in some embeds; URL contract changes per cycle).
//   - University of Wyoming serves a stable wrapper HTML at predictable URLs
//     but the inner GIF requires HTML scraping.
//   - IEM autoplot for skew-T uses different plot IDs per release.
// Operators clicking "open in new tab" gives a reliable, current view.

export type RaobStation = {
  /** ICAO/FAA-style code used by SPC sounding pages */
  spcStn: string;
  /** WMO station number (UWyo `STNM` parameter) */
  wmo: string;
  /** IEM `station:` autoplot parameter */
  iemStn: string;
  name: string;
  state: string;
};

// Mid-South RAOB sites + neighboring stations the operator typically watches
// during inflow / storm tracking. Order = display order in the picker.
export const RAOB_STATIONS: RaobStation[] = [
  { spcStn: 'BMX',  wmo: '72230', iemStn: 'BMX',  name: 'Birmingham',         state: 'AL' },
  { spcStn: 'BNA',  wmo: '72327', iemStn: 'BNA',  name: 'Nashville',          state: 'TN' },
  { spcStn: 'JAN',  wmo: '72235', iemStn: 'JAN',  name: 'Jackson',            state: 'MS' },
  { spcStn: 'LIT',  wmo: '72340', iemStn: 'LIT',  name: 'Little Rock',        state: 'AR' },
  { spcStn: 'LZK',  wmo: '72340', iemStn: 'LZK',  name: 'North Little Rock',  state: 'AR' },
  { spcStn: 'MEM',  wmo: '72334', iemStn: 'MEM',  name: 'Memphis',            state: 'TN' },
  { spcStn: 'SHV',  wmo: '72248', iemStn: 'SHV',  name: 'Shreveport',         state: 'LA' },
  { spcStn: 'OUN',  wmo: '72357', iemStn: 'OUN',  name: 'Norman (OK ref)',    state: 'OK' },
  { spcStn: 'FWD',  wmo: '72249', iemStn: 'FWD',  name: 'Fort Worth (TX ref)', state: 'TX' },
];

export const RAOB_DEFAULT_STN = 'MEM';

// External viewer URL builders. None of these are iframe targets — the panel
// renders them as links that open in a new tab.

export function uwyoUrl(stn: RaobStation): string {
  // Use the current UTC time; UWyo's CGI snaps to the nearest 00/12Z release.
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = now.getUTCHours() >= 12 ? '12' : '00';
  const dh = `${dd}${hh}`;
  return (
    'https://weather.uwyo.edu/cgi-bin/sounding'
    + '?region=naconf&TYPE=GIF%3ASKEWT'
    + `&YEAR=${yyyy}&MONTH=${mm}&FROM=${dh}&TO=${dh}&STNM=${stn.wmo}`
  );
}

export function spcSoundingUrl(stn: RaobStation): string {
  // SPC's interactive viewer. Drops to the latest available sounding for
  // the chosen station — no manual time picking required.
  return `https://www.spc.noaa.gov/exper/soundings/?stn=${stn.spcStn}&type=OBS`;
}

export function iemSoundingUrl(stn: RaobStation): string {
  // IEM RAOB sounding page (renders the most recent observed plus selectable
  // archives). The autoplot family is in flux — this top-level page is the
  // stable entry point.
  return `https://mesonet.agron.iastate.edu/raob/?network=RAOB&station=${stn.iemStn}`;
}
