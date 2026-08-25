import { useEffect, type ReactNode } from 'react'

export default function Modal(props: {
  title: string
  wide?: boolean
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  return (
    <div className="overlay" onMouseDown={props.onClose}>
      <div
        className={`modal ${props.wide ? 'wide' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={props.title}
      >
        <header className="modal-title">{props.title}</header>
        {props.children}
      </div>
    </div>
  )
}
