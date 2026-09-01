
// ── The only mocked thing: Graph and the session ─────────────────────────────
// Every payload below came out of the real pipeline (scripts/demo-page.js).
(() => {
  const D = window.DEMO;
  const json = (body) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const real = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const q = new URLSearchParams(u.split('?')[1] || '');

    if (u === '/api/me' || u.startsWith('/api/me?')) {
      return json({ authenticated: true, user: { name: 'Sales Rep', email: 'rep@lumendi-example.com' } });
    }
    if (u.startsWith('/api/calendar/')) return json(D.day);
    if (u.startsWith('/api/meetings/outside')) {
      return json(D.outside[q.get('eventId')] || { status: 'no_name', groups: [], failures: [], searched: false });
    }
    if (u.startsWith('/api/meetings/match')) {
      const ev = D.day.events.find((e) => e.id === q.get('eventId'));
      return json({ eventId: q.get('eventId'), ...(ev?.match || { status: 'no_name' }) });
    }
    if (u.startsWith('/api/meetings/choose')) {
      const body = JSON.parse(opts.body || '{}');
      const picked = D.chosen[body.npi];
      return json({
        saved: true, eventId: body.eventId, cleared: !body.npi, storedIn: 'demo',
        inBis: !picked, physician: picked?.physician || null, html: picked?.html || null,
      });
    }
    const brief = u.match(/^\/api\/physicians\/([^/]+)\/brief/);
    if (brief) return json({ html: D.briefs[brief[1]] || '<p class="muted">Not generated for this demo.</p>' });
    const note = u.match(/^\/api\/physicians\/([^/]+)\/notes/);
    if (note) return json({ notes: D.notes[note[1]] || [] });
    if (u.startsWith('/api/email-intel')) return json({ rows: [] });
    if (u.startsWith('/api/physicians/search')) return json({ physicians: [] });
    if (u.startsWith('/api/leads')) return json({ configured: false, leads: [] });
    return real(url, opts);
  };

  // ?open=<n> expands one case straight away — handy for sharing a link to the
  // exact behaviour being discussed.
  window.addEventListener('load', () => {
    const n = new URLSearchParams(location.search).get('open');
    if (n === null) return;
    setTimeout(() => {
      const li = document.querySelectorAll('#eventList .event')[Number(n)];
      if (li && !li.classList.contains('event--open')) li.querySelector('.event__title').click();
    }, 400);
  });

  // A one-line caption per meeting, so the page explains itself.
  window.addEventListener('load', () => {
    setTimeout(() => {
      document.querySelectorAll('#eventList .event').forEach((li, i) => {
        const ev = D.day.events[i];
        if (!ev?.demoNote) return;
        const tag = document.createElement('p');
        tag.className = 'muted';
        tag.style.cssText = 'margin:2px 0 0;font-size:12px;color:#7a2048';
        tag.textContent = `demo case: ${ev.demoNote}`;
        li.querySelector('.event__title')?.after(tag);
      });
    }, 300);
  });
})();
