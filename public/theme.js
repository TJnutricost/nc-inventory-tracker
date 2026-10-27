// The chosen appearance (Settings > Appearance), applied before the stylesheet loads so a dark page never flashes light. A file of
// its own, not inline: the Content-Security-Policy allows no inline script.
try { var t = localStorage.getItem('nc-theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) { /* storage blocked: System */ }
