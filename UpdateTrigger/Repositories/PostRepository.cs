using System.Collections.Concurrent;
using UpdateTrigger.Models;

namespace UpdateTrigger.Repositories
{
    public class PostRepository
    {
        private readonly ConcurrentDictionary<int, Post> _posts = new();
        private int _nextId = 1;

        public PostRepository()
        {
            // Initialize with some sample posts
            AddPost(new Post { Title = "First Post", Content = "This is the first post content" });
            AddPost(new Post { Title = "Second Post", Content = "This is the second post content" });
        }

        public Post AddPost(Post post)
        {
            post.Id = _nextId++;
            post.CreatedAt = DateTime.UtcNow;
            _posts[post.Id] = post;
            return post;
        }

        public Post? GetPost(int id)
        {
            _posts.TryGetValue(id, out var post);
            return post;
        }

        public IEnumerable<Post> GetAllPosts()
        {
            return _posts.Values.OrderByDescending(p => p.CreatedAt);
        }

        public bool LikePost(int id)
        {
            if (_posts.TryGetValue(id, out var post))
            {
                post.LikesCount++;
                return true;
            }
            return false;
        }
    }
}
