import { useEffect, useState } from 'hono/jsx'
import { render } from 'hono/jsx/dom'
import { api, checked, type Provider } from './api'
import { Brand, ErrorNotice } from './components'
import { Platforms } from './platforms'
import './style.css'

function App() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    api.providers
      .$get()
      .then(checked)
      .then((catalog) => {
        if (active) setProviders(catalog.items)
      })
      .catch((cause: Error) => {
        if (active) setError(cause.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [revision])
  return (
    <>
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <header>
        <div class="header-inner">
          <Brand />
          <a class="text-link" href="https://github.com/realmroot/adapters" target="_blank" rel="noreferrer">
            Source code <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>
      <main id="main">
        {error ? (
          <ErrorNotice message={error} retry={() => setRevision(revision + 1)} />
        ) : loading ? (
          <div class="loading" role="status">
            Loading platforms…
          </div>
        ) : (
          <Platforms providers={providers} />
        )}
      </main>
      <footer>
        <Brand />
        <span class="footer-note">One Agent identity. Connected to your world.</span>
        <a href="https://github.com/realmroot/adapters" target="_blank" rel="noreferrer">
          Open source <span aria-hidden="true">↗</span>
        </a>
      </footer>
    </>
  )
}

const root = document.getElementById('app')
if (!root) throw new Error('Directory root is missing.')
render(<App />, root)
