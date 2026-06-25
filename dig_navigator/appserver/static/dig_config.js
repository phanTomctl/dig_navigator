require([
    "jquery",
    "splunkjs/mvc",
    "splunkjs/mvc/simplexml/ready!"
], function($, mvc) {

    console.log("dig_config.js loaded");

    const endpoint = Splunk.util.make_url(
        "/splunkd/__raw/servicesNS/nobody/dig_navigator/dig_config"
    );

    function runAction(buttonId, statusId, action, runningText) {
        const button = $(buttonId);
        const status = $(statusId);

        button.prop("disabled", true);
        status.text(runningText);

        $.ajax({
            url: endpoint,
            type: "POST",
            data: {
                action: action
            },
            contentType: "application/x-www-form-urlencoded; charset=UTF-8",
            dataType: "json",
            success: function(data) {
                status.text("Success: " + JSON.stringify(data));
            },
            error: function(xhr) {
                status.text("Error " + xhr.status + ": " + xhr.responseText);
            },
            complete: function() {
                button.prop("disabled", false);
            }
        });
    }

    $(document).on("click", "#run_scrape_btn", function(e) {
        e.preventDefault();
        runAction("#run_scrape_btn", "#scrape_status", "scrape_fields", "Refreshing field metadata...");
    });

    $(document).on("click", "#build_tags_btn", function(e) {
        e.preventDefault();
        runAction("#build_tags_btn", "#tag_status", "build_tags", "Refreshing datamodel tag mappings...");
    });

    $(document).on("click", "#run_all_btn", function(e) {
        e.preventDefault();
        runAction("#run_all_btn", "#run_all_status", "run_all", "Refreshing DIG configuration...");
    });

});