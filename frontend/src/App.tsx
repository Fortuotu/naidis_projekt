import { useState, useEffect } from 'react'

function App() {
  const [health, setHealth] = useState('');

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => setHealth(`backend: ${data.status}, db: ${data.db}`))
      .catch(() => setHealth("request failed"));
  }, []);

  return (
    <p>{health}</p>
  );
}

export default App
