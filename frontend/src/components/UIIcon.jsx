/** Small, consistent outline icons for the navigation surfaces. */
export default function UIIcon({ name, size = 20, className = '' }) {
  const paths = {
    moon: <path d="M20.2 15.5A8.5 8.5 0 0 1 8.5 3.8a8.5 8.5 0 1 0 11.7 11.7Z" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    close: <path d="M5 5 19 19M19 5 5 19" />,
    pin: <><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    locate: <><circle cx="12" cy="12" r="4" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    back: <path d="m15 18-6-6 6-6" />,
    water: <><path d="M12 2c3.3 4.7 6 8.3 6 12a6 6 0 0 1-12 0c0-3.7 2.7-7.3 6-12Z" /><path d="M9 16a3 3 0 0 0 3 3" /></>,
    restroom: <><circle cx="8" cy="4" r="2" /><circle cx="17" cy="4" r="2" /><path d="M8 8v6m-3 7 1-11h4l1 11M17 8v13m-3-11h6" /></>,
    food: <><path d="M4 3v7a3 3 0 0 0 6 0V3M7 3v18M18 3c-3 2-4 5-4 9h4v9" /></>,
    route: <><circle cx="5" cy="18" r="2" /><circle cx="19" cy="5" r="2" /><path d="M7 18h5c4 0 0-11 5-11" /></>,
    straight: <path d="M12 21V4m-5 5 5-5 5 5" />,
    left: <path d="M20 20V11a4 4 0 0 0-4-4H4m5-5L4 7l5 5" />,
    right: <path d="M4 20V11a4 4 0 0 1 4-4h12m-5-5 5 5-5 5" />,
    uturn: <path d="M19 20V10a7 7 0 0 0-14 0v3m-3-3 3 3 3-3" />,
    chat: <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5 9 9 0 0 1-3.2-.6L4 20l1.6-5.3A8.5 8.5 0 0 1 4 11.5 8 8 0 0 1 12 4a8 8 0 0 1 8 7.5Z" />,
    send: <path d="m3 20 18-8L3 4l2 7 9 1-9 1-2 7Z" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
    check: <path d="m5 12 4.2 4.2L19 6.5" />,
    share: <><circle cx="18" cy="5" r="2" /><circle cx="6" cy="12" r="2" /><circle cx="18" cy="19" r="2" /><path d="m8 11 8-5M8 13l8 5" /></>,
  }
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}
