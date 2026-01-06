/**
 * Application Entry Point
 *
 * Initializes and renders the Motion Converter SolidJS application into
 * the DOM. Ensures the root container element exists before rendering
 * to prevent runtime errors.
 *
 * Flow:
 * 1. Import SolidJS render function and App component
 * 2. Import global styles
 * 3. Verify root element exists in DOM
 * 4. Render App component into root container
 */

import { render } from 'solid-js/web';
import App from './App';
import './index.css';

/**
 * Initialize application by rendering App component
 *
 * @remarks
 * - Verifies root HTML element exists before rendering
 * - Throws descriptive error if root element is missing
 * - Uses SolidJS render() for optimal reactivity and performance
 */
const root = document.getElementById('root');

if (!root) {
  throw new Error(
    'Root element (#root) not found in DOM. Ensure index.html contains a <div id="root"></div> element.'
  );
}

render(() => <App />, root);
