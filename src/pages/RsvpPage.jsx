import { useState } from 'react'
import './pages.css'

const RSVP_STORAGE_KEY = 'movieui_rsvp_draft'

const getInitialForm = () => {
  try {
    const cached = window.localStorage.getItem(RSVP_STORAGE_KEY)
    if (cached) return JSON.parse(cached)
  } catch {
    // Ignore invalid local cache and fall back to defaults.
  }
  return {
    guestName: '',
    phone: '',
    attending: 'yes',
    guestCount: '2',
    mealPreference: 'veg',
    note: '',
  }
}

export default function RsvpPage() {
  const [form, setForm] = useState(getInitialForm)
  const [submitted, setSubmitted] = useState(false)

  const updateField = (field, value) => {
    const next = { ...form, [field]: value }
    setForm(next)
    window.localStorage.setItem(RSVP_STORAGE_KEY, JSON.stringify(next))
  }

  const onSubmit = (event) => {
    event.preventDefault()
    setSubmitted(true)
  }

  return (
    <main className="invite-page-shell">
      <header className="invite-page-header">
        <a className="invite-back-link" href="#/">← Back to Gallery</a>
        <h1>RSVP</h1>
        <p>Please confirm your attendance for the celebration.</p>
      </header>

      <section className="invite-card">
        {submitted ? (
          <div className="invite-success">
            <h2>Thank you, {form.guestName || 'Guest'}!</h2>
            <p>Your RSVP is noted. We are excited to celebrate with you.</p>
            <a className="invite-primary-btn" href="#/">Go to Main Page</a>
          </div>
        ) : (
          <form className="invite-form" onSubmit={onSubmit}>
            <label>
              <span>Guest Name</span>
              <input
                type="text"
                value={form.guestName}
                onChange={(e) => updateField('guestName', e.target.value)}
                placeholder="Enter your full name"
                required
              />
            </label>

            <label>
              <span>Phone Number</span>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => updateField('phone', e.target.value)}
                placeholder="+91 98765 43210"
                required
              />
            </label>

            <label>
              <span>Will you attend?</span>
              <select
                value={form.attending}
                onChange={(e) => updateField('attending', e.target.value)}
              >
                <option value="yes">Yes, with pleasure</option>
                <option value="no">Sorry, can't make it</option>
              </select>
            </label>

            <label>
              <span>Number of Guests</span>
              <select
                value={form.guestCount}
                onChange={(e) => updateField('guestCount', e.target.value)}
              >
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5+</option>
              </select>
            </label>

            <label>
              <span>Meal Preference</span>
              <select
                value={form.mealPreference}
                onChange={(e) => updateField('mealPreference', e.target.value)}
              >
                <option value="veg">Vegetarian</option>
                <option value="non-veg">Non-Vegetarian</option>
                <option value="jain">Jain</option>
              </select>
            </label>

            <label>
              <span>Special Note (optional)</span>
              <textarea
                rows={4}
                value={form.note}
                onChange={(e) => updateField('note', e.target.value)}
                placeholder="Allergy info, travel details, etc."
              />
            </label>

            <button className="invite-primary-btn" type="submit">Submit RSVP</button>
          </form>
        )}
      </section>
    </main>
  )
}

