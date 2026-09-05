import type { Provider } from './api'

export function Brand() {
  return (
    <a class="brand" href="/" aria-label="Realmroot Adapters home">
      <img class="brand-logo" src="/realmroot-logo.png" width="30" height="30" alt="" />
      <span>
        realmroot<span class="brand-divider">/</span>
        <strong>adapters</strong>
      </span>
    </a>
  )
}

export function ProviderMark({ provider }: { provider: Pick<Provider, 'id' | 'name' | 'color' | 'mark'> }) {
  return (
    <span class={`provider-mark mark-${provider.id}`} style={{ '--mark': provider.color }} aria-hidden="true">
      {provider.mark}
    </span>
  )
}

export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div class="error-notice" role="alert">
      <p>{message}</p>
      {retry && (
        <button type="button" class="button secondary small" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  )
}
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div class="empty">
      <span class="empty-symbol" aria-hidden="true">
        ◇
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  )
}
