import './pages.css'

const events = [
  {
    title: 'Mehendi Ceremony',
    date: '18 December 2025',
    time: '4:30 PM onwards',
    venue: 'Lotus Banquet, Chennai',
    description: 'A colorful evening with mehendi, music, and family games.',
  },
  {
    title: 'Sangeet Night',
    date: '19 December 2025',
    time: '7:00 PM onwards',
    venue: 'Grand Ballroom, Chennai',
    description: 'Dance, performances, and dinner celebration with both families.',
  },
  {
    title: 'Wedding Ceremony',
    date: '20 December 2025',
    time: '6:30 AM to 10:30 AM',
    venue: 'Temple Hall, Chennai',
    description: 'Sacred wedding rituals followed by blessings from elders.',
  },
  {
    title: 'Reception',
    date: '20 December 2025',
    time: '6:30 PM onwards',
    venue: 'Royal Convention Center, Chennai',
    description: 'Grand reception with dinner and photo moments.',
  },
]

export default function EventsPage() {
  return (
    <main className="invite-page-shell">
      <header className="invite-page-header">
        <a className="invite-back-link" href="#/">← Back to Gallery</a>
        <h1>Event Schedule</h1>
        <p>Save the dates and join us for each celebration.</p>
      </header>

      <section className="invite-card invite-events-list">
        {events.map((eventItem) => (
          <article key={eventItem.title} className="invite-event-card">
            <h2>{eventItem.title}</h2>
            <p className="invite-event-meta">{eventItem.date} • {eventItem.time}</p>
            <p className="invite-event-venue">📍 {eventItem.venue}</p>
            <p>{eventItem.description}</p>
          </article>
        ))}
      </section>
    </main>
  )
}

