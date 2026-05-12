/**
 * Local JSON bundle for organisation.html when Supabase is not used.
 * Persists to localStorage; use Export / Import on the page to sync a .json file into the repo.
 */
(function (w) {
  'use strict';

  const KEY = 'pulse_organisation_bundle_v1';

  function uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return String(Date.now()) + '-' + Math.random().toString(36).slice(2, 11);
  }

  function defaultBundle() {
    const oid = uid();
    return {
      schemaVersion: 1,
      organisation: {
        id: oid,
        name: 'Bazaar Print',
        short_description: '',
        website_url: '',
        logo_url: '',
        logo_data_url: '',
        saved: false
      },
      people: [],
      facilities: [],
      hardwareByFacilityId: {}
    };
  }

  function normalizeBundle(o) {
    if (!o || typeof o !== 'object' || !o.organisation || !o.organisation.id) return defaultBundle();
    if (!Array.isArray(o.facilities)) o.facilities = [];
    if (!o.hardwareByFacilityId || typeof o.hardwareByFacilityId !== 'object') o.hardwareByFacilityId = {};
    if (!Array.isArray(o.people)) o.people = [];
    if (!o.schemaVersion) o.schemaVersion = 1;
    o.organisation.logo_url = o.organisation.logo_url || '';
    o.organisation.logo_data_url = o.organisation.logo_data_url || '';
    o.organisation.website_url = o.organisation.website_url || '';
    o.organisation.short_description = o.organisation.short_description || '';
    if (typeof o.organisation.saved !== 'boolean') o.organisation.saved = false;
    return o;
  }

  function loadRaw() {
    try {
      const raw = w.localStorage.getItem(KEY);
      if (!raw) return defaultBundle();
      return normalizeBundle(JSON.parse(raw));
    } catch (e) {
      console.warn('[PulseOrgJsonStore]', e);
      return defaultBundle();
    }
  }

  function saveRaw(bundle) {
    w.localStorage.setItem(KEY, JSON.stringify(normalizeBundle(bundle)));
  }

  function exportDownload(bundle, filename) {
    const blob = new Blob([JSON.stringify(normalizeBundle(bundle), null, 2)], { type: 'application/json' });
    const a = w.document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'pulse-organisation.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  w.PulseOrgJsonStore = {
    KEY: KEY,
    uid: uid,
    defaultBundle: defaultBundle,
    loadRaw: loadRaw,
    saveRaw: saveRaw,
    exportDownload: exportDownload,
    normalizeBundle: normalizeBundle
  };
})(window);
