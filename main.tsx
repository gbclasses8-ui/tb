/**
 * GB STUDY Application Entry Point
 */
import './index.css';

// Clear any previous devtools lockout tokens
try {
  localStorage.removeItem('tb_security_lockout_until');
  localStorage.removeItem('tb_security_lockout_start');
  localStorage.removeItem('tb_security_lockout_reason');
} catch {}

// Mount GB STUDY bundle
const script = document.createElement('script');
script.type = 'module';
script.src = '/assets/gbstudy.js';
document.head.appendChild(script);

