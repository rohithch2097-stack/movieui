import { useEffect, useMemo, useState } from 'react'
import App from './App.jsx'
import RsvpPage from './pages/RsvpPage.jsx'
import EventsPage from './pages/EventsPage.jsx'
import GalleryPage from './pages/GalleryPage.jsx'

const normalizeHashRoute = (hashValue = '') => {
  const path = hashValue.replace(/^#/, '').trim()
  if (!path || path === '/') return '/'
  return path.startsWith('/') ? path : `/${path}`
}

export default function AppRouter() {
  const [route, setRoute] = useState(() => normalizeHashRoute(window.location.hash))

  useEffect(() => {
    const onHashChange = () => setRoute(normalizeHashRoute(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const page = useMemo(() => {
    if (route === '/rsvp') return <RsvpPage />
    if (route === '/events') return <EventsPage />
    if (route === '/gallery') return <GalleryPage />
    return <App />
  }, [route])

  return page
}

