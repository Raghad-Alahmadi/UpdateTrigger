namespace UpdateTrigger.Models
{
    public class Post
    {
        public int Id { get; set; }
        public string Title { get; set; } = string.Empty;
        public string Content { get; set; } = string.Empty;
        public int LikesCount { get; set; }
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    }

    public class PostUpdateEvent
    {
        public Post Post { get; set; } = null!;
        public string UpdateType { get; set; } = string.Empty;
    }
}
