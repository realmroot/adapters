import { useState } from 'hono/jsx'
import type { Provider } from './api'
import { Empty, ProviderMark } from './components'

export function Platforms({ providers }: { providers: Provider[] }) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All platforms')
  const categories = ['All platforms', ...new Set(providers.map((provider) => provider.category))]
  const filtered = providers.filter(
    (provider) =>
      (category === 'All platforms' || provider.category === category) &&
      `${provider.name} ${provider.description} ${provider.capabilities.join(' ')}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  )
  return (
    <>
      <section class="hero">
        <div class="eyebrow">
          <span class="status-dot" /> THE REALMROOT ECOSYSTEM
        </div>
        <h1>
          Your tools.
          <br />
          <span class="hero-accent">Your Agents, connected.</span>
        </h1>
        <p>
          A familiar workspace, a new kind of collaborator.
          <br class="desktop-break" /> Connect your Agents to the platforms you already use, with an identity you can
          trace.
        </p>
        <div class="hero-bottom">
          <span class="hero-count">{String(providers.length).padStart(2, '0')}</span>
          <span>
            supported platforms
            <br />
            <strong>and growing</strong>
          </span>
          <div class="hero-rule" />
          <span class="hero-note">
            One identity.
            <br />
            Access you control.
          </span>
        </div>
        <div class="orbit" aria-hidden="true">
          <div class="orbit-inner">
            <img src="/realmroot-logo.png" width="64" height="64" alt="" />
          </div>
          <span class="orbit-label ol-top">TOOLS YOU TRUST</span>
          <span class="orbit-label ol-bottom">AGENTS YOU AUTHORIZE</span>
          <i class="orbit-node node-one">GH</i>
          <i class="orbit-node node-two">C7</i>
          <i class="orbit-node node-three">CF</i>
          <i class="orbit-node node-four">L</i>
        </div>
      </section>
      <section aria-labelledby="directory-title">
        <div class="section-heading">
          <div>
            <div class="eyebrow">EXPLORE THE DIRECTORY</div>
            <h2 id="directory-title">Built for the way you work.</h2>
          </div>
          <label class="search">
            <span aria-hidden="true">⌕</span>
            <span class="sr-only">Search platforms</span>
            <input
              type="search"
              value={search}
              onInput={(e) => setSearch((e.currentTarget as HTMLInputElement).value)}
              placeholder="Search platforms…"
            />
          </label>
        </div>
        <fieldset class="filters">
          <legend class="sr-only">Platform categories</legend>
          {categories.map((item) => (
            <button
              type="button"
              key={item}
              class={category === item ? 'selected' : ''}
              aria-pressed={category === item}
              onClick={() => setCategory(item)}
            >
              {item}
              {item === 'All platforms' && <span class="category-count">{providers.length}</span>}
            </button>
          ))}
        </fieldset>
        <div class="platform-grid">
          {filtered.map((provider) => (
            <article class="platform-card" key={provider.id}>
              <div class="card-top">
                <ProviderMark provider={provider} />
                <span class="maturity">{provider.maturity}</span>
              </div>
              <h3>{provider.name}</h3>
              <p>{provider.description}</p>
              <div class="capabilities">
                {provider.capabilities.map((capability) => (
                  <span key={capability}>{capability}</span>
                ))}
              </div>
              <div class="card-bottom">
                <span class={provider.enabled ? 'availability' : 'muted'}>
                  <span class={`status-dot ${provider.enabled ? '' : 'neutral'}`} />
                  {provider.enabled ? 'Available' : 'Not enabled here'}
                </span>
                <a
                  href={`https://github.com/realmroot/adapters/tree/main/providers/${provider.id}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Read about ${provider.name}`}
                >
                  Explore <span aria-hidden="true">↗</span>
                </a>
              </div>
            </article>
          ))}
        </div>
        {filtered.length === 0 && <Empty title="No matching platforms" text="Try a different name or category." />}
      </section>
    </>
  )
}
