import { useAuth } from '../../auth/AuthProvider'

// Home page shown in the workspace at /office.
export default function OfficeHome() {
  const { state } = useAuth()
  if (state.status !== 'authenticated') return null

  return (
    <>
      <h1 className="office-title">Home</h1>
      <p className="office-lead">Welcome, {state.staff.fullName}.</p>
    </>
  )
}
