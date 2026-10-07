import { Link } from 'react-router'
import { OFFICE_HOME_PATH } from '../../auth/AuthProvider'

// Unknown /office/* paths, shown inside the shell.
export default function OfficeNotFound() {
  return (
    <>
      <h1 className="office-title">Not found</h1>
      <p className="office-lead">This page does not exist.</p>
      <Link to={OFFICE_HOME_PATH}>Go to Home</Link>
    </>
  )
}
