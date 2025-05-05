using Microsoft.AspNetCore.Mvc;
using UpdateTrigger.Models;
using UpdateTrigger.Repositories;
using UpdateTrigger.Services;

namespace UpdateTrigger.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class PostController : ControllerBase
    {
        private readonly PostRepository _postRepository;
        private readonly PostSubscriptionService _subscriptionService;
        private readonly ILogger<PostController> _logger;

        public PostController(
            PostRepository postRepository,
            PostSubscriptionService subscriptionService,
            ILogger<PostController> logger)
        {
            _postRepository = postRepository;
            _subscriptionService = subscriptionService;
            _logger = logger;
        }

        [HttpGet]
        public IActionResult GetAllPosts()
        {
            return Ok(_postRepository.GetAllPosts());
        }

        [HttpGet("{id}")]
        public IActionResult GetPost(int id)
        {
            var post = _postRepository.GetPost(id);
            if (post == null)
                return NotFound();

            return Ok(post);
        }

        [HttpPost("{id}/like")]
        public async Task<IActionResult> LikePost(int id)
        {
            if (!_postRepository.LikePost(id))
                return NotFound();

            var post = _postRepository.GetPost(id);

            // Publish update to subscribers
            await _subscriptionService.PublishUpdateAsync(new PostUpdateEvent
            {
                Post = post!,
                UpdateType = "like"
            });

            return Ok(post);
        }

        [HttpPost("subscribe")]
        public IActionResult Subscribe([FromQuery] int? postId = null)
        {
            string subscriptionId = _subscriptionService.Subscribe(
                update => _logger.LogInformation($"Update received: {update.UpdateType} for post {update.Post.Id}"),
                postId);

            return Ok(new { SubscriptionId = subscriptionId });
        }
        [HttpGet("subscribe-sse")]
        public async Task SubscribeToUpdates([FromQuery] int? postId = null)
        {
            var response = Response;
            response.Headers.Add("Content-Type", "text/event-stream");
            response.Headers.Add("Cache-Control", "no-cache");
            response.Headers.Add("Connection", "keep-alive");

            var tcs = new TaskCompletionSource<bool>();
            string subscriptionId = "";

            try
            {
                // Set up the subscription using the existing service
                subscriptionId = _subscriptionService.Subscribe(async update =>
                {
                    try
                    {
                        var data = System.Text.Json.JsonSerializer.Serialize(update);
                        await response.WriteAsync($"data: {data}\n\n");
                        await response.Body.FlushAsync();
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Error sending SSE update");
                        tcs.TrySetResult(true); // Signal to end the connection
                    }
                }, postId);

                _logger.LogInformation($"Client connected to SSE stream with subscription ID: {subscriptionId}");

                // Keep the connection open until client disconnects
                HttpContext.RequestAborted.Register(() =>
                {
                    _logger.LogInformation($"Client disconnected from SSE stream: {subscriptionId}");
                    _subscriptionService.Unsubscribe(subscriptionId);
                    tcs.TrySetResult(true);
                });

                await tcs.Task;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in SSE connection");
                if (!string.IsNullOrEmpty(subscriptionId))
                {
                    _subscriptionService.Unsubscribe(subscriptionId);
                }
            }
        }


        [HttpDelete("unsubscribe/{subscriptionId}")]
        public IActionResult Unsubscribe(string subscriptionId)
        {
            bool result = _subscriptionService.Unsubscribe(subscriptionId);
            if (!result)
                return NotFound();

            return NoContent();
        }
    }
}
