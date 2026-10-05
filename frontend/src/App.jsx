import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import PostsPage from './pages/PostsPage';
import StatsPage from './pages/StatsPage';
import TasksPage from './pages/TasksPage';
import CharactersPage from './pages/CharactersPage';
import { TagProvider } from './contexts/TagContext';

function App() {
  return (
    <TagProvider>
      <Router>
        <Routes>
          <Route path="/" element={<PostsPage key="all" scope="all" />} />
          <Route path="/favorites" element={<PostsPage key="liked" scope="liked" />} />
          <Route path="/characters" element={<CharactersPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/tasks" element={<TasksPage />} />
        </Routes>
      </Router>
    </TagProvider>
  );
}

export default App;
