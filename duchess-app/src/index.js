import React from 'react'
import ReactDOM from 'react-dom/client'

const root = ReactDOM.createRoot(document.getElementById('root'))

if (process.env.NODE_ENV !== 'production' && process.env.REACT_APP_TUS_LOCAL_ONLY === '1') {
  import('./tusLocalSafariHarness').then((mod) => {
    root.render(<React.StrictMode><mod.TusLocalSafariHarness /></React.StrictMode>)
  })
} else if (process.env.NODE_ENV !== 'production' && process.env.REACT_APP_SAFARI_S12_ONLY === '1') {
  import('./safariS12Harness').then((mod) => {
    root.render(<React.StrictMode><mod.SafariS12Harness /></React.StrictMode>)
  })
} else if (process.env.REACT_APP_PHOTO_UPLOAD_RECOVERY === '1') {
  import('./photoUploadRecoveryEntry').then((mod) => {
    root.render(<React.StrictMode><mod.PhotoUploadRecoveryEntry /></React.StrictMode>)
  })
} else {
  import('./App').then((mod) => {
    root.render(<React.StrictMode><mod.default /></React.StrictMode>)
  })
}
