const navToggle = document.querySelector('.nav-toggle');
const navMenu = document.querySelector('#nav-menu');
const demoOutput = document.querySelector('#demo-output');
const demoButtons = document.querySelectorAll('[data-demo-state]');

const demoText = {
  original: 'john@doe.com\nsk-proj-abc123...',
  masked: '[REDACTED_EMAIL]\n[REDACTED_API_KEY]'
};

navToggle?.addEventListener('click', () => {
  const isOpen = navMenu.classList.toggle('open');
  navToggle.setAttribute('aria-expanded', String(isOpen));
  navToggle.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
  document.body.classList.toggle('nav-open', isOpen);
});

document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', () => {
    navMenu?.classList.remove('open');
    navToggle?.setAttribute('aria-expanded', 'false');
    navToggle?.setAttribute('aria-label', 'Open navigation');
    document.body.classList.remove('nav-open');
  });
});

demoButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const state = button.dataset.demoState;
    demoButtons.forEach((item) => item.classList.toggle('active', item === button));
    demoOutput.textContent = demoText[state];
  });
});

document.querySelector('.newsletter')?.addEventListener('submit', (event) => {
  event.preventDefault();
});
