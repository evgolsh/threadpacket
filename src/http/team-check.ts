/**
 * The live check on the two "Create a team" forms (/join and the sign-in page an assistant opens). As the person
 * types, it asks /join/check whether the team name is free and shows the answer under the field. The server
 * still decides on submit; the check only saves a round trip. Usernames are per team, so they are never taken
 * at sign-up: the username field only checks its own format here.
 */
export const TEAM_CHECK_SCRIPT = `(() => {
  for (const form of document.querySelectorAll("form[data-team-check]")) {
    const handle = form.querySelector('[name="handle"]');
    const team = form.querySelector('[name="team"]');
    const handleOut = form.querySelector('[data-avail="handle"]');
    const teamOut = form.querySelector('[data-avail="team"]');
    if (!handle || !team || !handleOut || !teamOut) continue;
    const show = (el, text, state) => { el.textContent = text; el.dataset.state = state; };
    let timer = 0;
    let latest = 0;
    const check = async () => {
      const h = handle.value.trim().toLowerCase();
      const t = team.value.trim().toLowerCase();
      if (h && h.length < 3) show(handleOut, "At least 3 characters.", "bad");
      else if (h && !/^[a-z0-9][a-z0-9._-]*$/.test(h)) show(handleOut, "Letters, digits, dots, underscores or hyphens, starting with a letter or digit.", "bad");
      else if (h === "team" || h === "all") show(handleOut, "team and all are reserved.", "bad");
      else show(handleOut, "", "");
      if (!t && h.length < 3) { show(teamOut, teamOut.dataset.help || "", ""); return; }
      const mine = ++latest;
      try {
        const res = await fetch("/join/check?" + new URLSearchParams({ team: t, handle: h }), { headers: { accept: "application/json" } });
        if (mine !== latest || !res.ok) return;
        const out = await res.json();
        show(teamOut, out.message, out.state);
      } catch {}
    };
    const later = () => { clearTimeout(timer); timer = setTimeout(check, 250); };
    // A phone keyboard adds a space after a word. The fields accept it and the server trims it; drop it from view too.
    const tidy = (el) => { const v = el.value.trim(); if (v !== el.value) el.value = v; };
    for (const el of [handle, team]) {
      el.addEventListener("input", later);
      el.addEventListener("change", () => tidy(el));
    }
    if (handle.value || team.value) check();
  }
})();`;

/** The CSS for the answer under a field: a green check when free, a red cross when taken or not allowed. */
export const AVAIL_CSS = `.field-help:empty{display:none}
.field-help[data-state=ok]{color:var(--ok)}.field-help[data-state=ok]::before{content:"\\2713\\00a0"}
.field-help[data-state=taken],.field-help[data-state=bad]{color:var(--danger)}
.field-help[data-state=taken]::before,.field-help[data-state=bad]::before{content:"\\2717\\00a0"}`;
